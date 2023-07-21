const babel = require("@rollup/plugin-babel");
const resolve = require("@rollup/plugin-node-resolve");
const commonJS = require("@rollup/plugin-commonjs");
const json = require("@rollup/plugin-json");

module.exports = {
	input: './src/index.js',
	output: {
		format: 'iife',
		file: 'build/cp-prosemirror-markdown.js',
		name: 'MarkdownEditor'
	},
	plugins: [
		babel({
			babelHelpers: 'bundled'
		}),
		resolve({
			preferBuiltins: false
		}),
		commonJS({
			include: 'node_modules/**'
		}),
		json()
	]
};
