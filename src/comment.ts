import {Line, EditorState, TransactionSpec, StateCommand} from "@codemirror/state"

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
  let {state} = target, line = state.doc.lineAt(state.selection.main.from), config = getConfig(target.state, line.from)
  return config.line ? toggleLineComment(target) : config.block ? toggleBlockCommentByLine(target) : false
}

const enum CommentOption { Toggle, Comment, Uncomment }

function command(f: (option: CommentOption, state: EditorState) => TransactionSpec | null,
                 option: CommentOption): StateCommand {
  return ({state, dispatch}) => {
    if (state.readOnly) return false
    let tr = f(option, state)
    if (!tr) return false
    dispatch(state.update(tr))
    return true
  }
}

/// Comment or uncomment the current selection using line comments.
/// The line comment syntax is taken from the
/// [`commentTokens`](#commands.CommentTokens) [language
/// data](#state.EditorState.languageDataAt).
export const toggleLineComment = command(changeLineComment, CommentOption.Toggle)

/// Comment the current selection using line comments.
export const lineComment = command(changeLineComment, CommentOption.Comment)

/// Uncomment the current selection using line comments.
export const lineUncomment = command(changeLineComment, CommentOption.Uncomment)

/// Comment or uncomment the current selection using block comments.
/// The block comment syntax is taken from the
/// [`commentTokens`](#commands.CommentTokens) [language
/// data](#state.EditorState.languageDataAt).
export const toggleBlockComment = command(changeBlockComment, CommentOption.Toggle)

/// Comment the current selection using block comments.
export const blockComment = command(changeBlockComment, CommentOption.Comment)

/// Uncomment the current selection using block comments.
export const blockUncomment = command(changeBlockComment, CommentOption.Uncomment)

/// Comment or uncomment the lines around the current selection using
/// block comments.
export const toggleBlockCommentByLine =
  command((o, s) => changeBlockComment(o, s, selectedLineRanges(s)), CommentOption.Toggle)

function getConfig(state: EditorState, pos: number) {
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
function findBlockComment(
  state: EditorState, {open, close}: BlockToken, from: number, to: number
): BlockComment | null {
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

function selectedLineRanges(state: EditorState) {
  let ranges: {from: number, to: number}[] = []
  for (let r of state.selection.ranges) {
    let fromLine = state.doc.lineAt(r.from)
    let toLine = r.to <= fromLine.to ? fromLine : state.doc.lineAt(r.to)
    let last = ranges.length - 1
    if (last >= 0 && ranges[last].to > fromLine.from) ranges[last].to = toLine.to
    else ranges.push({from: fromLine.from + /^\s*/.exec(fromLine.text)![0].length, to: toLine.to})
  }
  return ranges
}

// Performs toggle, comment and uncomment of block comments in
// languages that support them.
function changeBlockComment(
  option: CommentOption,
  state: EditorState,
  ranges: readonly {from: number, to: number}[] = state.selection.ranges,
) {
  let tokens = ranges.map(r => getConfig(state, r.from).block) as {open: string, close: string}[]
  if (!tokens.every(c => c)) return null
  let comments = ranges.map((r, i) => findBlockComment(state, tokens[i], r.from, r.to))
  if (option != CommentOption.Uncomment && !comments.every(c => c)) {
    return {changes: state.changes(ranges.map((range, i) => {
      if (comments[i]) return []
      return [{from: range.from, insert: tokens[i].open + " "}, {from: range.to, insert: " " + tokens[i].close}]
    }))}
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
  state: EditorState,
  ranges: readonly {from: number, to: number}[] = state.selection.ranges,
): TransactionSpec | null {
  let lines: {line: Line, token: string, comment: number, empty: boolean, indent: number, single: boolean}[] = []
  let prevLine = -1
  for (let {from, to} of ranges) {
    let startI = lines.length, minIndent = 1e9
    let token = getConfig(state, from).line
    if (!token) continue
    for (let pos = from; pos <= to;) {
      let line = state.doc.lineAt(pos)
      if (line.from > prevLine && (from == to || to > line.from)) {
        prevLine = line.from
        let indent = /^\s*/.exec(line.text)![0].length
        let empty = indent == line.length
        let comment = line.text.slice(indent, indent + token.length) == token ? indent : -1
        if (indent < line.text.length && indent < minIndent) minIndent = indent
        lines.push({line, comment, token, indent, empty, single: false})
      }
      pos = line.to + 1
    }
    if (minIndent < 1e9) for (let i = startI; i < lines.length; i++)
      if (lines[i].indent < lines[i].line.text.length) lines[i].indent = minIndent
    if (lines.length == startI + 1) lines[startI].single = true
  }

  if (option != CommentOption.Uncomment && lines.some(l => l.comment < 0 && (!l.empty || l.single))) {
    let changes = []
    for (let {line, token, indent, empty, single} of lines) if (single || !empty)
      changes.push({from: line.from + indent, insert: token + " "})
    let changeSet = state.changes(changes)
    return {changes: changeSet, selection: state.selection.map(changeSet, 1)}
  } else if (option != CommentOption.Comment && lines.some(l => l.comment >= 0)) {
    let changes = []
    for (let {line, comment, token} of lines) if (comment >= 0) {
      let from = line.from + comment, to = from + token.length
      if (line.text[to - line.from] == " ") to++
      changes.push({from, to})
    }
    return {changes}
  }
  return null
}
