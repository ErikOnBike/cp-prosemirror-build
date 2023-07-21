import * as view from "prosemirror-view";
const { EditorView, Decoration, DecorationSet } = view;
import * as state from "prosemirror-state";
const { EditorState, Selection, Plugin } = state;
import * as model from "prosemirror-model";
const { NodeType, Schema } = model;
import * as markdown from "prosemirror-markdown";
const { schema, defaultMarkdownParser, defaultMarkdownSerializer } = markdown;
import * as transform from "prosemirror-transform";
const { Step } = transform;
import * as schemaList from "prosemirror-schema-list";
const { wrapInList, splitListItem, liftListItem, sinkListItem } = schemaList;
import * as inputrules from "prosemirror-inputrules";
const { inputRules, wrappingInputRule, textblockTypeInputRule, smartQuotes, emDash, ellipsis, undoInputRule } = inputrules;
import * as keymap from "prosemirror-keymap";
import * as commands from "prosemirror-commands";
const { baseKeymap, wrapIn, setBlockType, chainCommands, toggleMark, exitCode, joinUp, joinDown, lift, selectParentNode } = commands;
import * as history from "prosemirror-history";
const { undo, redo } = history;
import * as collaboration from "prosemirror-collab";
const {collab, receiveTransaction, sendableSteps, getVersion} = collaboration;
import * as dropcursor from "prosemirror-dropcursor";
import * as gapcursor from "prosemirror-gapcursor";

// Global constants
const MAX_STEP_HISTORY = 10000;
const DEFAULT_DEBOUNCE_PERIOD = 500;	// Milliseconds

// Public (API) methods (using Smalltalk style selectors)

// Add a Markdown editor to the specified element (with optional content and version)
window["addMarkdownEditorTo:"] = (element) => {

	// Validate a Markdown editor is not already installed
	if(element.markdownEditor) {
		return;
	}

	// Add 'empty' Markdown editor and connect it to the specified element
	element.markdownEditor = new MarkdownEditorView(undefined, element, "", 0);

	return element.firstElementChild;
};

// Remove the Markdown editor created in the specified element
window["removeMarkdownEditorFrom:"] = (element) => {
	if(element.markdownEditor) {
		element.markdownEditor.destroy();
		delete element.markdownEditor;
	}
};


// Answer the content (String containing Markdown description) of the Markdown
// editor created in the specified element or null otherwise
window["getMarkdownEditorContentFrom:"] = (element) => {
	if(element.markdownEditor) {
		return element.markdownEditor.getContent();
	}
	return null;
};

// Answer the selection (Dictionary containing selection: from & to) of the Markdown
// editor created in the specified element or null otherwise
window["getMarkdownEditorSelectionFrom:"] = (element) => {
	if(element.markdownEditor) {
		return element.markdownEditor.getSelection();
	}
	return null;
};

// Update the content (String containing Markdown description) of the Markdown
// editor created in the specified element using the specified version for
// collaboration
window["updateMarkdownEditorIn:withContent:version:clientID:"] = (element, content, version, clientID) => {
	if(element.markdownEditor) {
		element.markdownEditor.updateContent(content, version, clientID);
	}
};

// Update the steps of a change (from either the client itself or another client)
window["updateMarkdownEditorIn:withSteps:version:selection:clientID:"] = (element, steps, version, selection, clientID) => {
	if(element.markdownEditor) {
		element.markdownEditor.receiveSteps(steps, version, selection, clientID);
	}
};

// Update the selection of the specified client
window["updateMarkdownEditorIn:setSelection:clientID:"] = (element, selection, clientID) => {
	if(element.markdownEditor) {
		element.markdownEditor.setSelection(selection, clientID);
	}
};

// Remove the selection of the specified client
window["updateMarkdownEditorIn:removeSelectionClientID:"] = (element, clientID) => {
	if(element.markdownEditor) {
		element.markdownEditor.removeSelection(clientID);
	}
};

// Plugin for sharing selections (incl. cursors)
const sharedSelectionPluginId = "CpSharedSelectionPlugin";
const sharedSelectionPluginKey = new Plugin(sharedSelectionPluginId);

function sharedSelectionPlugin(clientID) {
	const plugin = new Plugin({
		key: sharedSelectionPluginKey,
		state: {
			init: () => {
				return DecorationSet.empty;
			},
			apply: (transaction, decorationSet) => {
				decorationSet = decorationSet.map(transaction.mapping, transaction.doc);
				const command = transaction.getMeta("selections");

				// If no command is given, simply return
				if(!command) {
					return decorationSet;
				}

				// Handle command
				if(command.set) {
					// Do not set the selection for the client itself
					if(command.clientID === clientID) {
						return decorationSet;
					}

					// Find or create decorations for cursor and selection (optional).
					// Empty selections are not allowed (you would not be able to see or
					// manipulate an empty selection from the editor).
					// The decoration instances are added to and removed from the decoration
					// set repeatedly. This is necessary to be recognized as 'changed'. The
					// same instance of the decorations can be used however.

					// Find or create cursor (cursor is mandatory)
					const selection = command.selection;
					let cursorDecoration = findDecoration(decorationSet, command.clientID, "cursor");
					if(!cursorDecoration) {
						const widget = document.createElement("cp-pm-cursor");
						widget.setAttribute("data-clientid", command.clientID);
						cursorDecoration = Decoration.widget(selection.from, widget, {
							id: sharedSelectionPluginId,
							clientID: command.clientID,
							type: "cursor"
						});
						decorationSet = decorationSet.add(transaction.doc, [ cursorDecoration ]);
					}

					// Update cursor
					if(cursorDecoration.from !== selection.from) {
						decorationSet = decorationSet.remove([ cursorDecoration ]);
						cursorDecoration.from = cursorDecoration.to = command.selection.from;
						decorationSet = decorationSet.add(transaction.doc, [ cursorDecoration ]);
					}

					// Update selection (selection is optional)
					let selectionDecoration = findDecoration(decorationSet, command.clientID, "selection");
					if(selection.from === selection.to) {
						// No selection (only cursor), remove existing decoration
						if(selectionDecoration) {
							decorationSet = decorationSet.remove([ selectionDecoration ]);
						}
					} else {
						// Update or add selection decoration
						if(selectionDecoration) {
							if(selectionDecoration.from !== selection.from || selectionDecoration.to !== selection.to) {
								decorationSet = decorationSet.remove([ selectionDecoration ]);
								selectionDecoration.from = selection.from;
								selectionDecoration.to = selection.to;
								decorationSet = decorationSet.add(transaction.doc, [ selectionDecoration ]);
							}
						} else {
							selectionDecoration = Decoration.inline(selection.from, selection.to, { class: "shared-selection" }, {
								id: sharedSelectionPluginId,
								clientID: command.clientID,
								type: "selection"
							});
							decorationSet = decorationSet.add(transaction.doc, [ selectionDecoration ]);
						}
					}
				} else if(command.remove) {
					const decorations = [];
					const cursorDecoration = findDecoration(decorationSet, command.clientID, "cursor");
					if(cursorDecoration) {
						decorations.push(cursorDecoration);
					}
					const selectionDecoration = findDecoration(decorationSet, command.clientID, "selection");
					if(selectionDecoration) {
						decorations.push(selectionDecoration);
					}
					if(decorations.length > 0) {
						decorationSet = decorationSet.remove(decorations);
					}
				}

				return decorationSet;
			}
		},
		props: {
			decorations: (state) => {
				return plugin.getState(state);
			}
		}
	});
	return plugin;
}

// Helper function to find a specified shared selection decoration
function findDecoration(decorationSet, clientID, type) {
	const findResult = decorationSet.find(null, null, (spec) => {
		return spec.id === sharedSelectionPluginId && spec.clientID === clientID && spec.type === type;
	});
	return findResult.length > 0 ? findResult[0] : null;
}


// View for the Markdown WYSIWYM document editor
class MarkdownEditorView extends Object {

	clientID;	// Unique ID for this editor
	element;	// DOM element the editor view is attached to
	view;		// View which contains the editor content area
	debouncer;	// Debouncer for change announcements
	debounceTime;	// Number of milliseconds to debounce announcements
	debounceDetail;	// The information being debounced

	// Public methods
	constructor(clientID, element, content, version) {
		super();

		this.clientID = clientID;

		// Create and attach editor view
		this.element = element;
		this.view = new EditorView(this.element, MarkdownEditorView.createEditorProps(this, content, version, clientID));
	}

	destroy() {
		// Safely dispose of editor
		if(this.view) {
			this.view.destroy();
		}

		// Clean up
		this.element = null;
		this.view = null;
	}

	getContent() {
		return defaultMarkdownSerializer.serialize(this.view.state.doc);
	}
	getSelection() {
		return this.view.state.selection.toJSON();
	}
	updateContent(content, version, clientID) {
		// This will also 'reset' the undo/history state, etc.
		try {
			this.view.updateState(MarkdownEditorView.createEditorStateForContent(content, version, clientID));
		} catch(error) {
			console.error("Error updating content: " + error);
		}
	}

	receiveSteps(steps, version, selection, clientID) {
		try {
			const clientIDs = new Array(steps.length);
			clientIDs.fill(clientID);
			const transaction = receiveTransaction(this.view.state, steps.map((step) => { return Step.fromJSON(schema, step); }), clientIDs);
			const newState = this.view.state.apply(transaction);
			this.view.updateState(newState);
			this.setSelection(selection, clientID);
		} catch(error) {
			console.error("Error receiving steps: " + error);
		}
	}

	setSelection(selection, clientID) {
		// Ignore set selection for receiver
		if(selection === null || !clientID || clientID === this.clientID) {
			return;
		}
		try {
			const state = this.view.state;
			this.view.dispatch(state.tr.setMeta("selections", {
				set: true,
				selection: Selection.fromJSON(state.doc, selection),
				clientID: clientID
			}));
		} catch(error) {
			// Selection out of range?
			if(error instanceof RangeError) {
				// Ignore range error, probably will be set correctly shortly after
			} else {
				console.error("Error setting selection: " + error);
			}
		}
	}

	removeSelection(clientID) {
		try {
			const state = this.view.state;
			this.view.dispatch(state.tr.setMeta("selections", {
				remove: true,
				clientID: clientID
			}));
		} catch(error) {
			console.error("Error removing selection: " + error);
		}
	}

	// Private instance methods
	dispatchTransaction(transaction) {
		try {
			const newState = this.view.state.apply(transaction);
			this.view.updateState(newState);
			const sendable = sendableSteps(newState);
			if(sendable) {
				this.announceChange({
					steps: sendable.steps.map((step) => { return step.toJSON() }),
					selection: transaction.selectionSet ? transaction.selection.toJSON() : null,
					version: sendable.version
				});
			} else if(transaction.selectionSet) {
				// Send empty steps collection and current version number when only updating a selection
				this.announceChange({
					steps: [],
					selection: transaction.selection.toJSON(),
					version: getVersion(newState)
				});
			}
		} catch(error) {
			console.error("Error applying transaction: " + error, transaction);
		}
	}

	announceChange(detail) {
		this.debounceDetail = detail;
		if(!this.debouncer) {
			// Create debouncer
			this.debouncer = window.setTimeout(() => {
				this.element.dispatchEvent(new CustomEvent("pmdocumentchange", {
					bubbles: true,
					composed: true,
					detail: this.debounceDetail
				}));

				// Reset debouncer and debouncer information
				this.debouncer = null;
				this.debounceDetail = null;
			}, this.debounceTime || DEFAULT_DEBOUNCE_PERIOD);
		}
	}

	// Private class methods
	static createEditorProps(editor, content, version, clientID) {
		return {
			state: MarkdownEditorView.createEditorStateForContent(content, version, clientID),
			dispatchTransaction: (transaction) => { editor.dispatchTransaction(transaction); }
		};
	}
	static createEditorStateForContent(content, version, clientID) {
		return EditorState.create({
			schema: schema,
			doc: defaultMarkdownParser.parse(content),
			plugins: [
				this.inputRules(),
				this.keymap(),
				keymap.keymap(baseKeymap),
				dropcursor.dropCursor(),
				gapcursor.gapCursor(),
				history.history(),
				collab({ version: version, clientID: clientID }),
				sharedSelectionPlugin(clientID)
			]
		});
	}

	// Plugins
	static inputRules() {
		return inputRules({
			rules: [].concat(
				smartQuotes,
				ellipsis,
				emDash,
				wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
				wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, match => ({order: +match[1]}), (match, node) => node.childCount + node.attrs.order == +match[1]),
				wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
				textblockTypeInputRule(/^\x60{3}$/, schema.nodes.code_block),	// Three backticks
				textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, match => ({level: match[1].length}))
			)
		});
	}
	static keymap() {
		const hardBreak = chainCommands(exitCode, (state, dispatch) => {
			if(dispatch) {
				dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
				return true
			}
		});
		const platformKeymap = {
			macos: {
				"Ctrl-Enter": hardBreak
			},
			windows: {
				"Mod-y": redo
			},
			linux: {
				"Mod-y": redo
			}
		};
		return keymap.keymap({
			"Mod-z": undo,
			"Shift-Mod-z": redo,
			"Backspace": undoInputRule,

			"Alt-ArrowUp": joinUp,
			"Alt-ArrowDown": joinDown,
			"Mod-BracketLeft": lift,
			"Escape": selectParentNode,

			"Mod-b": toggleMark(schema.marks.strong),
			"Mod-B": toggleMark(schema.marks.strong),

			"Mod-i": toggleMark(schema.marks.em),
			"Mod-I": toggleMark(schema.marks.em),

			//"Mod-`": toggleMark(schema.marks.code),	// This also swaps between instamces of an application on macOS

			"Shift-Ctrl-8": wrapInList(schema.nodes.bullet_list),
			"Shift-Ctrl-9": wrapInList(schema.nodes.ordered_list),
			"Ctrl->": wrapIn(schema.nodes.blockquote),

			"Mod-Enter": hardBreak,
			"Shift-Enter": hardBreak,

			"Enter": splitListItem(schema.nodes.list_item),
			"Mod-[": liftListItem(schema.nodes.list_item),
			"Mod-]": sinkListItem(schema.nodes.list_item),

			"Shift-Ctrl-0": setBlockType(schema.nodes.paragraph),
			"Shift-Ctrl-\\": setBlockType(schema.nodes.code_block),
			"Shift-Ctrl-1": setBlockType(schema.nodes.heading, { level: 1 }),
			"Shift-Ctrl-2": setBlockType(schema.nodes.heading, { level: 2 }),
			"Shift-Ctrl-3": setBlockType(schema.nodes.heading, { level: 3 }),
			"Shift-Ctrl-4": setBlockType(schema.nodes.heading, { level: 4 }),
			"Shift-Ctrl-5": setBlockType(schema.nodes.heading, { level: 5 }),
			"Shift-Ctrl-6": setBlockType(schema.nodes.heading, { level: 6 }),
			"Mod-_": (state, dispatch) => {
				if(dispatch) {
					dispatch(state.tr.replaceSelectionWith(schema.nodes,horizontal_rule.create()).scrollIntoView());
				}
				return true;
			}
		});
	}
}
