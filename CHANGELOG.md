## 0.17.3 (2021-02-16)

### Bug fixes

Fix an issue where `insertNewlineAndIndent` behaved strangely with the cursor between brackets that sat on different lines.

## 0.17.2 (2021-01-22)

### New features

The new `insertTab` command inserts a tab when nothing is selected, and defers to `indentMore` otherwise.

The package now exports a `defaultTabBinding` object that provides a recommended binding for tab (if you must bind tab).

## 0.17.1 (2021-01-06)

### New features

The package now also exports a CommonJS module.

## 0.17.0 (2020-12-29)

### Breaking changes

First numbered release.

