import {Line} from "@codemirror/text"
import {EditorState, TransactionSpec, EditorSelection, StateCommand} from "@codemirror/state"
import {KeyBinding} from "@codemirror/view"

/// An object of this type can be provided as [language
/// data](#state.EditorState.languageDataAt) under a `"commentTokens"`
/// property to configure comment syntax for a language.
export interface CommentTokens {
  /// The block comment syntax, if any. For example, for HTML
  /// you'd provide `{open: "<!--", close: "-->"}`.
  block?: {open: string, close: string},
  /// The line comment syntax. For example `"//"`.
  line?: string
}

/// Comment or uncomment the current selection. Will use line comments
/// if available, otherwise falling back to block comments.
export const toggleComment: StateCommand = target => {
  let config = getConfig(target.state)
  return config.line ? toggleLineComment(target) : config.block ? toggleBlockComment(target) : false
}

function command(f: (option: CommentOption, ranges: readonly {readonly from: number, readonly to: number}[],
                     state: EditorState) => TransactionSpec | null,
                 option: CommentOption): StateCommand {
  return ({state, dispatch}) => {
    let tr = f(option, state.selection.ranges, state)
    if (!tr) return false
    dispatch(state.update(tr))
    return true
  }
}

/// Comment or uncomment the current selection using line comments.
/// The line comment syntax is taken from the
/// [`commentTokens`](#comment.CommentTokens) [language
/// data](#state.EditorState.languageDataAt).
export const toggleLineComment = command(changeLineComment, CommentOption.Toggle)

/// Comment the current selection using line comments.
export const lineComment = command(changeLineComment, CommentOption.Comment)

/// Uncomment the current selection using line comments.
export const lineUncomment = command(changeLineComment, CommentOption.Uncomment)

/// Comment or uncomment the current selection using block comments.
/// The block comment syntax is taken from the
/// [`commentTokens`](#comment.CommentTokens) [language
/// data](#state.EditorState.languageDataAt).
export const toggleBlockComment = command(changeBlockComment, CommentOption.Toggle)

/// Comment the current selection using block comments.
export const blockComment = command(changeBlockComment, CommentOption.Comment)

/// Uncomment the current selection using block comments.
export const blockUncomment = command(changeBlockComment, CommentOption.Uncomment)

/// Default key bindings for this package.
///
///  - Ctrl-/ (Cmd-/ on macOS): [`toggleComment`](#comment.toggleComment).
///  - Shift-Alt-a: [`toggleBlockComment`](#comment.toggleBlockComment).
export const commentKeymap: readonly KeyBinding[] = [
  {key: "Mod-/", run: toggleComment},
  {key: "Alt-A", run: toggleBlockComment}
]

const enum CommentOption { Toggle, Comment, Uncomment }

function getConfig(state: EditorState, pos = state.selection.main.head) {
  let data = state.languageDataAt<CommentTokens>("commentTokens", pos)
  return data.length ? data[0] : {}
}

type BlockToken = {open: string, close: string}

type BlockComment = {
  open: {pos: number, margin: number},
  close: {pos: number, margin: number}
}

const SearchMargin = 50

/// Determines if the given range is block-commented in the given
/// state.
function findBlockComment(state: EditorState, {open, close}: BlockToken, from: number, to: number): BlockComment | null {
  let textBefore = state.sliceDoc(from - SearchMargin, from)
  let textAfter = state.sliceDoc(to, to + SearchMargin)
  let spaceBefore = /\s*$/.exec(textBefore)![0].length, spaceAfter = /^\s*/.exec(textAfter)![0].length
  let beforeOff = textBefore.length - spaceBefore
  if (textBefore.slice(beforeOff - open.length, beforeOff) == open &&
    textAfter.slice(spaceAfter, spaceAfter + close.length) == close) {
    return {open: {pos: from - spaceBefore, margin: spaceBefore && 1},
            close: {pos: to + spaceAfter, margin: spaceAfter && 1}}
  }

  let startText: string, endText: string
  if (to - from <= 2 * SearchMargin) {
    startText = endText = state.sliceDoc(from, to)
  } else {
    startText = state.sliceDoc(from, from + SearchMargin)
    endText = state.sliceDoc(to - SearchMargin, to)
  }
  let startSpace = /^\s*/.exec(startText)![0].length, endSpace = /\s*$/.exec(endText)![0].length
  let endOff = endText.length - endSpace - close.length
  if (startText.slice(startSpace, startSpace + open.length) == open &&
      endText.slice(endOff, endOff + close.length) == close) {
    return {open: {pos: from + startSpace + open.length,
                   margin: /\s/.test(startText.charAt(startSpace + open.length)) ? 1 : 0},
            close: {pos: to - endSpace - close.length,
                    margin: /\s/.test(endText.charAt(endOff - 1)) ? 1 : 0}}
  }
  return null
}

// Performs toggle, comment and uncomment of block comments in
// languages that support them.
function changeBlockComment(
  option: CommentOption,
  ranges: readonly {readonly from: number, readonly to: number}[],
  state: EditorState
) {
  let tokens = ranges.map(r => getConfig(state, r.from).block) as {open: string, close: string}[]
  if (!tokens.every(c => c)) return null
  let comments = ranges.map((r, i) => findBlockComment(state, tokens[i], r.from, r.to))
  if (option != CommentOption.Uncomment && !comments.every(c => c)) {
    let index = 0
    return state.changeByRange(range => {
      let {open, close} = tokens[index++]
      if (comments[index]) return {range}
      let shift = open.length + 1
      return {
        changes: [{from: range.from, insert: open + " "}, {from: range.to, insert: " " + close}],
        range: EditorSelection.range(range.anchor + shift, range.head + shift)
      }
    })
  } else if (option != CommentOption.Comment && comments.some(c => c)) {
    let changes = []
    for (let i = 0, comment; i < comments.length; i++) if (comment = comments[i]) {
      let token = tokens[i], {open, close} = comment
      changes.push(
        {from: open.pos - token.open.length, to: open.pos + open.margin},
        {from: close.pos - close.margin, to: close.pos + token.close.length}
      )
    }
    return {changes}
  }
  return null
}

// Performs toggle, comment and uncomment of line comments.
function changeLineComment(
  option: CommentOption,
  ranges: readonly {readonly from: number, readonly to: number}[],
  state: EditorState
): TransactionSpec | null {
  let lines: {line: Line, token: string, comment: number, indent: number, single: boolean}[] = []
  let prevLine = -1
  for (let {from, to} of ranges) {
    let startI = lines.length, minIndent = 1e9
    for (let pos = from; pos <= to;) {
      let line = state.doc.lineAt(pos)
      if (line.from > prevLine && (from == to || to > line.from)) {
        prevLine = line.from
        let token = getConfig(state, pos).line
        if (!token) continue
        let indent = /^\s*/.exec(line.text)![0].length
        let comment = line.text.slice(indent, indent + token.length) == token ? indent : -1
        if (indent < line.text.length && indent < minIndent) minIndent = indent
        lines.push({line, comment, token, indent, single: false})
      }
      pos = line.to + 1
    }
    if (minIndent < 1e9) for (let i = startI; i < lines.length; i++)
      if (lines[i].indent < lines[i].line.text.length) lines[i].indent = minIndent
    if (lines.length == startI + 1) lines[startI].single = true
  }

  if (option != CommentOption.Comment && lines.some(l => l.comment >= 0)) {
    let changes = []
    for (let {line, comment, token} of lines) if (comment >= 0) {
      let from = line.from + comment, to = from + token.length
      if (line.text[to - line.from] == " ") to++
      changes.push({from, to})
    }
    return {changes}
  } else if (option != CommentOption.Uncomment && lines.some(l => l.comment < 0)) {
    let changes = []
    for (let {line, comment, token, indent, single} of lines) if (comment != indent && (single || /\S/.test(line.text)))
      changes.push({from: line.from + indent, insert: token + " "})
    let changeSet = state.changes(changes)
    return {changes: changeSet, selection: state.selection.map(changeSet, 1)}
  }
  return null
}
