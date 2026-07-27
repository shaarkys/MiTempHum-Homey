"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const homeyApp = require("eslint-plugin-homey-app");

module.exports = [
  {
    ignores: [
      ".homeybuild/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  homeyApp.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-undef": "warn",
      "no-unused-vars": "warn",
      "preserve-caught-error": "warn",
    },
  },
];
