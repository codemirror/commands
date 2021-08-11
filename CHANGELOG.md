## 0.19.1 (2021-08-11)

### Bug fixes

Fix incorrect versions for @lezer dependencies.

## 0.19.0 (2021-08-11)

### Breaking changes

Change default binding for backspace to `deleteCharBackward`, drop `deleteCodePointBackward`/`Forward` from the library.

`defaultTabBinding` was removed.

### Bug fixes

Drop Alt-d, Alt-f, and Alt-b bindings from `emacsStyleKeymap` (and thus from the default macOS bindings).

`deleteCharBackward` and `deleteCharForward` now take atomic ranges into account.

### New features

Attach more granular user event strings to transactions.

The module exports a new binding `indentWithTab` that binds tab and shift-tab to `indentMore` and `indentLess`.

## 0.18.3 (2021-06-11)

### Bug fixes

`moveLineDown` will no longer incorrectly grow the selection.

Line-based commands will no longer include lines where a range selection ends right at the start of the line.

## 0.18.2 (2021-05-06)

### Bug fixes

Use Ctrl-l, not Alt-l, to bind `selectLine` on macOS, to avoid conflicting with special-character-insertion bindings.

Make the macOS Command-ArrowLeft/Right commands behave more like their native versions.

## 0.18.1 (2021-04-08)

### Bug fixes

Also bind Shift-Backspace and Shift-Delete in the default keymap (to do the same thing as the Shift-less binding).

### New features

Adds a `deleteToLineStart` command.

Adds bindings for Cmd-Delete and Cmd-Backspace on macOS.

## 0.18.0 (2021-03-03)

### Breaking changes

Update dependencies to 0.18.

## 0.17.5 (2021-02-25)

### Bug fixes

Use Alt-l for the default `selectLine` binding, because Mod-l already has an important meaning in the browser.

Make `deleteGroupBackward`/`deleteGroupForward` delete groups of whitespace when bigger than a single space.

Don't change lines that have the end of a range selection directly at their start in `indentLess`, `indentMore`, and `indentSelection`.

## 0.17.4 (2021-02-18)

### Bug fixes

Fix a bug where `deleteToLineEnd` would delete the rest of the document when at the end of a line.

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

