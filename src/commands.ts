import {EditorState, StateCommand, EditorSelection, SelectionRange,
        ChangeSpec, Transaction, CharCategory} from "@codemirror/state"
import {findClusterBreak, Text, Line, countColumn, codePointAt, codePointSize} from "@codemirror/text"
import {EditorView, Command, Direction, KeyBinding} from "@codemirror/view"
import {matchBrackets} from "@codemirror/matchbrackets"
import {syntaxTree, IndentContext, getIndentUnit, indentUnit, indentString,
        getIndentation} from "@codemirror/language"
import {SearchCursor} from "@codemirror/search"
import {SyntaxNode, NodeProp} from "lezer-tree"

function updateSel(sel: EditorSelection, by: (range: SelectionRange) => SelectionRange) {
  return EditorSelection.create(sel.ranges.map(by), sel.mainIndex)
}

function setSel(state: EditorState, selection: EditorSelection | {anchor: number, head?: number}) {
  return state.update({selection, scrollIntoView: true, annotations: Transaction.userEvent.of("keyboardselection")})
}

type CommandTarget = {state: EditorState, dispatch: (tr: Transaction) => void}

function moveSel({state, dispatch}: CommandTarget,
                 how: (range: SelectionRange) => SelectionRange): boolean {
  let selection = updateSel(state.selection, how)
  if (selection.eq(state.selection)) return false
  dispatch(setSel(state, selection))
  return true
}

function rangeEnd(range: SelectionRange, forward: boolean) {
  return EditorSelection.cursor(forward ? range.to : range.from)
}

function cursorByChar(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? view.moveByChar(range, forward) : rangeEnd(range, forward))
}

/// Move the selection one character to the left (which is backward in
/// left-to-right text, forward in right-to-left text).
export const cursorCharLeft: Command = view => cursorByChar(view, view.textDirection != Direction.LTR)
/// Move the selection one character to the right.
export const cursorCharRight: Command = view => cursorByChar(view, view.textDirection == Direction.LTR)

/// Move the selection one character forward.
export const cursorCharForward: Command = view => cursorByChar(view, true)
/// Move the selection one character backward.
export const cursorCharBackward: Command = view => cursorByChar(view, false)

function cursorByGroup(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? view.moveByGroup(range, forward) : rangeEnd(range, forward))
}

/// Move the selection across one group of word or non-word (but also
/// non-space) characters.
export const cursorGroupLeft: Command = view => cursorByGroup(view, view.textDirection != Direction.LTR)
/// Move the selection one group to the right.
export const cursorGroupRight: Command = view => cursorByGroup(view, view.textDirection == Direction.LTR)

/// Move the selection one group forward.
export const cursorGroupForward: Command = view => cursorByGroup(view, true)
/// Move the selection one group backward.
export const cursorGroupBackward: Command = view => cursorByGroup(view, false)

function interestingNode(state: EditorState, node: SyntaxNode, bracketProp: NodeProp<unknown>) {
  if (node.type.prop(bracketProp)) return true
  let len = node.to - node.from
  return len && (len > 2 || /[^\s,.;:]/.test(state.sliceDoc(node.from, node.to))) || node.firstChild
}

function moveBySyntax(state: EditorState, start: SelectionRange, forward: boolean) {
  let pos = syntaxTree(state).resolve(start.head)
  let bracketProp = forward ? NodeProp.closedBy : NodeProp.openedBy
  // Scan forward through child nodes to see if there's an interesting
  // node ahead.
  for (let at = start.head;;) {
    let next = forward ? pos.childAfter(at) : pos.childBefore(at)
    if (!next) break
    if (interestingNode(state, next, bracketProp)) pos = next
    else at = forward ? next.to : next.from
  }
  let bracket = pos.type.prop(bracketProp), match, newPos
  if (bracket && (match = forward ? matchBrackets(state, pos.from, 1) : matchBrackets(state, pos.to, -1)) && match.matched)
    newPos = forward ? match.end!.to : match.end!.from
  else
    newPos = forward ? pos.to : pos.from
  return EditorSelection.cursor(newPos, forward ? -1 : 1)
}

/// Move the cursor over the next syntactic element to the left.
export const cursorSyntaxLeft: Command =
  view => moveSel(view, range => moveBySyntax(view.state, range, view.textDirection != Direction.LTR))
/// Move the cursor over the next syntactic element to the right.
export const cursorSyntaxRight: Command =
  view => moveSel(view, range => moveBySyntax(view.state, range, view.textDirection == Direction.LTR))

function cursorByLine(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? view.moveVertically(range, forward) : rangeEnd(range, forward))
}

/// Move the selection one line up.
export const cursorLineUp: Command = view => cursorByLine(view, false)
/// Move the selection one line down.
export const cursorLineDown: Command = view => cursorByLine(view, true)

function cursorByPage(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? view.moveVertically(range, forward, view.dom.clientHeight) : rangeEnd(range, forward))
}

/// Move the selection one page up.
export const cursorPageUp: Command = view => cursorByPage(view, false)
/// Move the selection one page down.
export const cursorPageDown: Command = view => cursorByPage(view, true)

function moveByLineBoundary(view: EditorView, start: SelectionRange, forward: boolean) {
  let line = view.visualLineAt(start.head), moved = view.moveToLineBoundary(start, forward)
  if (moved.head == start.head && moved.head != (forward ? line.to : line.from))
    moved = view.moveToLineBoundary(start, forward, false)
  if (!forward && moved.head == line.from && line.length) {
    let space = /^\s*/.exec(view.state.sliceDoc(line.from, Math.min(line.from + 100, line.to)))![0].length
    if (space && start.head != line.from + space) moved = EditorSelection.cursor(line.from + space)
  }
  return moved
}

/// Move the selection to the next line wrap point, or to the end of
/// the line if there isn't one left on this line.
export const cursorLineBoundaryForward: Command = view => moveSel(view, range => moveByLineBoundary(view, range, true))
/// Move the selection to previous line wrap point, or failing that to
/// the start of the line. If the line is indented, and the cursor
/// isn't already at the end of the indentation, this will move to the
/// end of the indentation instead of the start of the line.
export const cursorLineBoundaryBackward: Command = view => moveSel(view, range => moveByLineBoundary(view, range, false))

/// Move the selection to the start of the line.
export const cursorLineStart: Command = view => moveSel(view, range => EditorSelection.cursor(view.visualLineAt(range.head).from, 1))
/// Move the selection to the end of the line.
export const cursorLineEnd: Command = view => moveSel(view, range => EditorSelection.cursor(view.visualLineAt(range.head).to, -1))

function toMatchingBracket(state: EditorState, dispatch: (tr: Transaction) => void, extend: boolean) {
  let found = false, selection = updateSel(state.selection, range => {
    let matching = matchBrackets(state, range.head, -1)
      || matchBrackets(state, range.head, 1)
      || (range.head > 0 && matchBrackets(state, range.head - 1, 1))
      || (range.head < state.doc.length && matchBrackets(state, range.head + 1, -1))
    if (!matching || !matching.end) return range
    found = true
    let head = matching.start.from == range.head ? matching.end.to : matching.end.from
    return extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head)
  })
  if (!found) return false
  dispatch(setSel(state, selection))
  return true
}

/// Move the selection to the bracket matching the one it is currently
/// on, if any.
export const cursorMatchingBracket: StateCommand = ({state, dispatch}) => toMatchingBracket(state, dispatch, false)
/// Extend the selection to the bracket matching the one the selection
/// head is currently on, if any.
export const selectMatchingBracket: StateCommand = ({state, dispatch}) => toMatchingBracket(state, dispatch, true)

function extendSel(view: EditorView, how: (range: SelectionRange) => SelectionRange): boolean {
  let selection = updateSel(view.state.selection, range => {
    let head = how(range)
    return EditorSelection.range(range.anchor, head.head, head.goalColumn)
  })
  if (selection.eq(view.state.selection)) return false
  view.dispatch(setSel(view.state, selection))
  return true
}

function selectByChar(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveByChar(range, forward))
}

/// Move the selection head one character to the left, while leaving
/// the anchor in place.
export const selectCharLeft: Command = view => selectByChar(view, view.textDirection != Direction.LTR)
/// Move the selection head one character to the right.
export const selectCharRight: Command = view => selectByChar(view, view.textDirection == Direction.LTR)

/// Move the selection head one character forward.
export const selectCharForward: Command = view => selectByChar(view, true)
/// Move the selection head one character backward.
export const selectCharBackward: Command = view => selectByChar(view, false)

function selectByGroup(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveByGroup(range, forward))
}

/// Move the selection head one [group](#commands.cursorGroupLeft) to
/// the left.
export const selectGroupLeft: Command = view => selectByGroup(view, view.textDirection != Direction.LTR)
/// Move the selection head one group to the right.
export const selectGroupRight: Command = view => selectByGroup(view, view.textDirection == Direction.LTR)

/// Move the selection head one group forward.
export const selectGroupForward: Command = view => selectByGroup(view, true)
/// Move the selection head one group backward.
export const selectGroupBackward: Command = view => selectByGroup(view, false)

/// Move the selection head over the next syntactic element to the left.
export const selectSyntaxLeft: Command =
  view => extendSel(view, range => moveBySyntax(view.state, range, view.textDirection != Direction.LTR))
/// Move the selection head over the next syntactic element to the right.
export const selectSyntaxRight: Command =
  view => extendSel(view, range => moveBySyntax(view.state, range, view.textDirection == Direction.LTR))

function selectByLine(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveVertically(range, forward))
}

/// Move the selection head one line up.
export const selectLineUp: Command = view => selectByLine(view, false)
/// Move the selection head one line down.
export const selectLineDown: Command = view => selectByLine(view, true)

function selectByPage(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveVertically(range, forward, view.dom.clientHeight))
}

/// Move the selection head one page up.
export const selectPageUp: Command = view => selectByPage(view, false)
/// Move the selection head one page down.
export const selectPageDown: Command = view => selectByPage(view, true)

/// Move the selection head to the next line boundary.
export const selectLineBoundaryForward: Command = view => extendSel(view, range => moveByLineBoundary(view, range, true))
/// Move the selection head to the previous line boundary.
export const selectLineBoundaryBackward: Command = view => extendSel(view, range => moveByLineBoundary(view, range, false))

/// Move the selection head to the start of the line.
export const selectLineStart: Command = view => extendSel(view, range => EditorSelection.cursor(view.visualLineAt(range.head).from))
/// Move the selection head to the end of the line.
export const selectLineEnd: Command = view => extendSel(view, range => EditorSelection.cursor(view.visualLineAt(range.head).to))

/// Move the selection to the start of the document.
export const cursorDocStart: StateCommand = ({state, dispatch}) => {
  dispatch(setSel(state, {anchor: 0}))
  return true
}

/// Move the selection to the end of the document.
export const cursorDocEnd: StateCommand = ({state, dispatch}) => {
  dispatch(setSel(state, {anchor: state.doc.length}))
  return true
}

/// Move the selection head to the start of the document.
export const selectDocStart: StateCommand = ({state, dispatch}) => {
  dispatch(setSel(state, {anchor: state.selection.main.anchor, head: 0}))
  return true
}

/// Move the selection head to the end of the document.
export const selectDocEnd: StateCommand = ({state, dispatch}) => {
  dispatch(setSel(state, {anchor: state.selection.main.anchor, head: state.doc.length}))
  return true
}

/// Select the entire document.
export const selectAll: StateCommand = ({state, dispatch}) => {
  dispatch(state.update({selection: {anchor: 0, head: state.doc.length}, annotations: Transaction.userEvent.of("keyboardselection")}))
  return true
}

/// Expand the selection to cover entire lines.
export const selectLine: StateCommand = ({state, dispatch}) => {
  let ranges = selectedLineBlocks(state).map(({from, to}) => EditorSelection.range(from, Math.min(to + 1, state.doc.length)))
  dispatch(state.update({selection: EditorSelection.create(ranges), annotations: Transaction.userEvent.of("keyboardselection")}))
  return true
}

/// Select the next syntactic construct that is larger than the
/// selection. Note that this will only work insofar as the language
/// [provider](#language.language) you use builds up a full
/// syntax tree.
export const selectParentSyntax: StateCommand = ({state, dispatch}) => {
  let selection = updateSel(state.selection, range => {
    let context = syntaxTree(state).resolve(range.head, 1)
    while (!((context.from < range.from && context.to >= range.to) ||
             (context.to > range.to && context.from <= range.from) ||
             !context.parent?.parent))
      context = context.parent
    return EditorSelection.range(context.to, context.from)
  })
  dispatch(setSel(state, selection))
  return true
}

const selectWord: Command = (view) => {
  return moveSel(view, range => {
    let categorize = view.state.charCategorizer(range.from)

    let prev = view.state.sliceDoc(range.from - 1, range.from)
    let prevWord = categorize(prev) == CharCategory.Word
    let { from } = prevWord ? view.moveByGroup(range, false) : range

    let next = view.state.sliceDoc(range.from, range.from + 1)
    let nextWord = categorize(next) == CharCategory.Word
    let { to } = nextWord ? view.moveByGroup(range, true) : range

    return EditorSelection.range(from, to)
  })
}

const findNextOccurrence = (state: EditorState, searchedText: string) => {
  let { ranges } = state.selection
  let cursor = new SearchCursor(state.doc, searchedText, ranges[ranges.length - 1].to)

  let found = cursor.next()
  if (!cursor.done) return found.value

  cursor = new SearchCursor(state.doc, searchedText, 0, Math.max(0, ranges[ranges.length - 1].from - 1))

  while (true) {
    found = cursor.next()
    if (cursor.done) break
    if (!ranges.find((r) => r.from === found.value.from)) {
      return found.value
    }
  }

  return null
}

export const selectNextOccurrence: Command = (view) => {
  let { ranges } = view.state.selection
  if (ranges.some((sel) => sel.from === sel.to)) {
    selectWord(view)
    return true
  }

  let searchedText = view.state.sliceDoc(ranges[0].from, ranges[0].to)
  if (view.state.selection.ranges.some(
    (range) => view.state.sliceDoc(range.from, range.to) !== searchedText
  )) {
    return true
  }

  let range = findNextOccurrence(view.state, searchedText)

  if (range) {
    view.dispatch(setSel(view.state,
      view.state.selection.addRange(
        EditorSelection.range(range.from, range.to)
      )
    ))
  }
  return true
}

/// Simplify the current selection. When multiple ranges are selected,
/// reduce it to its main range. Otherwise, if the selection is
/// non-empty, convert it to a cursor selection.
export const simplifySelection: StateCommand = ({state, dispatch}) => {
  let cur = state.selection, selection = null
  if (cur.ranges.length > 1) selection = EditorSelection.create([cur.main])
  else if (!cur.main.empty) selection = EditorSelection.create([EditorSelection.cursor(cur.main.head)])
  if (!selection) return false
  dispatch(setSel(state, selection))
  return true
}

function deleteBy({state, dispatch}: CommandTarget, by: (start: number) => number) {
  let changes = state.changeByRange(range => {
    let {from, to} = range
    if (from == to) {
      let towards = by(from)
      from = Math.min(from, towards)
      to = Math.max(to, towards)
    }
    return from == to ? {range} : {changes: {from, to}, range: EditorSelection.cursor(from)}
  })
  if (changes.changes.empty) return false
  dispatch(state.update(changes, {scrollIntoView: true, annotations: Transaction.userEvent.of("delete")}))
  return true
}

const deleteByChar = (target: CommandTarget, forward: boolean, codePoint: boolean) => deleteBy(target, pos => {
  let {state} = target, line = state.doc.lineAt(pos), before
  if (!forward && pos > line.from && pos < line.from + 200 &&
      !/[^ \t]/.test(before = line.text.slice(0, pos - line.from))) {
    if (before[before.length - 1] == "\t") return pos - 1
    let col = countColumn(before, 0, state.tabSize), drop = col % getIndentUnit(state) || getIndentUnit(state)
    for (let i = 0; i < drop && before[before.length - 1 - i] == " "; i++) pos--
    return pos
  }
  let targetPos
  if (codePoint) {
    let next = line.text.slice(pos - line.from + (forward ? 0 : -2),
                               pos - line.from + (forward ? 2 : 0))
    let size = next ? codePointSize(codePointAt(next, 0)) : 1
    targetPos = forward ? Math.min(state.doc.length, pos + size) : Math.max(0, pos - size)
  } else {
    targetPos = findClusterBreak(line.text, pos - line.from, forward) + line.from
  }
  if (targetPos == pos && line.number != (forward ? state.doc.lines : 1))
    targetPos += forward ? 1 : -1
  return targetPos
})

/// Delete the selection, or, for cursor selections, the code point
/// before the cursor.
export const deleteCodePointBackward: Command = view => deleteByChar(view, false, true)
/// Delete the selection, or, for cursor selections, the code point
/// after the cursor.
export const deleteCodePointForward: Command = view => deleteByChar(view, true, true)

/// Delete the selection, or, for cursor selections, the character
/// before the cursor.
export const deleteCharBackward: Command = view => deleteByChar(view, false, false)
/// Delete the selection or the character after the cursor.
export const deleteCharForward: Command = view => deleteByChar(view, true, false)

const deleteByGroup = (target: CommandTarget, forward: boolean) => deleteBy(target, start => {
  let pos = start, {state} = target, line = state.doc.lineAt(pos)
  let categorize = state.charCategorizer(pos)
  for (let cat: CharCategory | null = null;;) {
    if (pos == (forward ? line.to : line.from)) {
      if (pos == start && line.number != (forward ? state.doc.lines : 1))
        pos += forward ? 1 : -1
      break
    }
    let next = findClusterBreak(line.text, pos - line.from, forward) + line.from
    let nextChar = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from)
    let nextCat = categorize(nextChar)
    if (cat != null && nextCat != cat) break
    if (nextChar != " " || pos != start) cat = nextCat
    pos = next
  }
  return pos
})

/// Delete the selection or backward until the end of the next
/// [group](#view.EditorView.moveByGroup), only skipping groups of
/// whitespace when they consist of a single space.
export const deleteGroupBackward: StateCommand = target => deleteByGroup(target, false)
/// Delete the selection or forward until the end of the next group.
export const deleteGroupForward: StateCommand = target => deleteByGroup(target, true)

/// Delete the selection, or, if it is a cursor selection, delete to
/// the end of the line. If the cursor is directly at the end of the
/// line, delete the line break after it.
export const deleteToLineEnd: Command = view => deleteBy(view, pos => {
  let lineEnd = view.visualLineAt(pos).to
  if (pos < lineEnd) return lineEnd
  return Math.min(view.state.doc.length, pos + 1)
})

/// Delete the selection, or, if it is a cursor selection, delete to
/// the start of the line. If the cursor is directly at the start of the
/// line, delete the line break before it.
export const deleteToLineStart: Command = view => deleteBy(view, pos => {
  let lineStart = view.visualLineAt(pos).from
  if (pos > lineStart) return lineStart
  return Math.max(0, pos - 1)
})

/// Delete all whitespace directly before a line end from the
/// document.
export const deleteTrailingWhitespace: StateCommand = ({state, dispatch}) => {
  let changes = []
  for (let pos = 0, prev = "", iter = state.doc.iter();;) {
    iter.next()
    if (iter.lineBreak || iter.done) {
      let trailing = prev.search(/\s+$/)
      if (trailing > -1) changes.push({from: pos - (prev.length - trailing), to: pos})
      if (iter.done) break
      prev = ""
    } else {
      prev = iter.value
    }
    pos += iter.value.length
  }
  if (!changes.length) return false
  dispatch(state.update({changes}))
  return true
}

/// Replace each selection range with a line break, leaving the cursor
/// on the line before the break.
export const splitLine: StateCommand = ({state, dispatch}) => {
  let changes = state.changeByRange(range => {
    return {changes: {from: range.from, to: range.to, insert: Text.of(["", ""])},
            range: EditorSelection.cursor(range.from)}
  })
  dispatch(state.update(changes, {scrollIntoView: true, annotations: Transaction.userEvent.of("input")}))
  return true
}

/// Flip the characters before and after the cursor(s).
export const transposeChars: StateCommand = ({state, dispatch}) => {
  let changes = state.changeByRange(range => {
    if (!range.empty || range.from == 0 || range.from == state.doc.length) return {range}
    let pos = range.from, line = state.doc.lineAt(pos)
    let from = pos == line.from ? pos - 1 : findClusterBreak(line.text, pos - line.from, false) + line.from
    let to = pos == line.to ? pos + 1 : findClusterBreak(line.text, pos - line.from, true) + line.from
    return {changes: {from, to, insert: state.doc.slice(pos, to).append(state.doc.slice(from, pos))},
            range: EditorSelection.cursor(to)}
  })
  if (changes.changes.empty) return false
  dispatch(state.update(changes, {scrollIntoView: true}))
  return true
}

function selectedLineBlocks(state: EditorState) {
  let blocks = [], upto = -1
  for (let range of state.selection.ranges) {
    let startLine = state.doc.lineAt(range.from), endLine = state.doc.lineAt(range.to)
    if (upto == startLine.number) blocks[blocks.length - 1].to = endLine.to
    else blocks.push({from: startLine.from, to: endLine.to})
    upto = endLine.number
  }
  return blocks
}

function moveLine(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean): boolean {
  let changes = []
  for (let block of selectedLineBlocks(state)) {
    if (forward ? block.to == state.doc.length : block.from == 0) continue
    let nextLine = state.doc.lineAt(forward ? block.to + 1 : block.from - 1)
    if (forward)
      changes.push({from: block.to, to: nextLine.to},
                   {from: block.from, insert: nextLine.text + state.lineBreak})
    else
      changes.push({from: nextLine.from, to: block.from},
                   {from: block.to, insert: state.lineBreak + nextLine.text})
  }
  if (!changes.length) return false
  dispatch(state.update({changes, scrollIntoView: true}))
  return true
}

/// Move the selected lines up one line.
export const moveLineUp: StateCommand = ({state, dispatch}) => moveLine(state, dispatch, false)
/// Move the selected lines down one line.
export const moveLineDown: StateCommand = ({state, dispatch}) => moveLine(state, dispatch, true)

function copyLine(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean): boolean {
  let changes = []
  for (let block of selectedLineBlocks(state)) {
    if (forward)
      changes.push({from: block.from, insert: state.doc.slice(block.from, block.to) + state.lineBreak})
    else
      changes.push({from: block.to, insert: state.lineBreak + state.doc.slice(block.from, block.to)})
  }
  dispatch(state.update({changes, scrollIntoView: true}))
  return true
}

/// Create a copy of the selected lines. Keep the selection in the top copy.
export const copyLineUp: StateCommand = ({state, dispatch}) => copyLine(state, dispatch, false)
/// Create a copy of the selected lines. Keep the selection in the bottom copy.
export const copyLineDown: StateCommand = ({state, dispatch}) => copyLine(state, dispatch, true)

/// Delete selected lines.
export const deleteLine: Command = view => {
  let {state} = view, changes = state.changes(selectedLineBlocks(state).map(({from, to}) => {
    if (from > 0) from--
    else if (to < state.doc.length) to++
    return {from, to}
  }))
  let selection = updateSel(state.selection, range => view.moveVertically(range, true)).map(changes)
  view.dispatch({changes, selection, scrollIntoView: true})
  return true
}

/// Replace the selection with a newline.
export const insertNewline: StateCommand = ({state, dispatch}) => {
  dispatch(state.update(state.replaceSelection(state.lineBreak), {scrollIntoView: true}))
  return true
}

function isBetweenBrackets(state: EditorState, pos: number): {from: number, to: number} | null {
  if (/\(\)|\[\]|\{\}/.test(state.sliceDoc(pos - 1, pos + 1))) return {from: pos, to: pos}
  let context = syntaxTree(state).resolve(pos)
  let before = context.childBefore(pos), after = context.childAfter(pos), closedBy
  if (before && after && before.to <= pos && after.from >= pos &&
      (closedBy = before.type.prop(NodeProp.closedBy)) && closedBy.indexOf(after.name) > -1 &&
      state.doc.lineAt(before.to).from == state.doc.lineAt(after.from).from)
    return {from: before.to, to: after.from}
  return null
}

/// Replace the selection with a newline and indent the newly created
/// line(s). If the current line consists only of whitespace, this
/// will also delete that whitespace. When the cursor is between
/// matching brackets, an additional newline will be inserted after
/// the cursor.
export const insertNewlineAndIndent: StateCommand = ({state, dispatch}): boolean => {
  let changes = state.changeByRange(({from, to}) => {
    let explode = from == to && isBetweenBrackets(state, from)
    let cx = new IndentContext(state, {simulateBreak: from, simulateDoubleBreak: !!explode})
    let indent = getIndentation(cx, from)
    if (indent == null) indent = /^\s*/.exec(state.doc.lineAt(from).text)![0].length

    let line = state.doc.lineAt(from)
    while (to < line.to && /\s/.test(line.text.slice(to - line.from, to + 1 - line.from))) to++
    if (explode) ({from, to} = explode)
    else if (from > line.from && from < line.from + 100 && !/\S/.test(line.text.slice(0, from))) from = line.from
    let insert = ["", indentString(state, indent)]
    if (explode) insert.push(indentString(state, cx.lineIndent(line)))
    return {changes: {from, to, insert: Text.of(insert)},
            range: EditorSelection.cursor(from + 1 + insert[1].length)}
  })
  dispatch(state.update(changes, {scrollIntoView: true}))
  return true
}

function changeBySelectedLine(state: EditorState, f: (line: Line, changes: ChangeSpec[], range: SelectionRange) => void) {
  let atLine = -1
  return state.changeByRange(range => {
    let changes: ChangeSpec[] = []
    for (let pos = range.from; pos <= range.to;) {
      let line = state.doc.lineAt(pos)
      if (line.number > atLine && (range.empty || range.to > line.from)) {
        f(line, changes, range)
        atLine = line.number
      }
      pos = line.to + 1
    }
    let changeSet = state.changes(changes)
    return {changes,
            range: EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1))}
  })
}

/// Auto-indent the selected lines. This uses the [indentation service
/// facet](#language.indentService) as source for auto-indent
/// information.
export const indentSelection: StateCommand = ({state, dispatch}) => {
  let updated: {[lineStart: number]: number} = Object.create(null)
  let context = new IndentContext(state, {overrideIndentation: start => {
    let found = updated[start]
    return found == null ? -1 : found
  }})
  let changes = changeBySelectedLine(state, (line, changes, range) => {
    let indent = getIndentation(context, line.from)
    if (indent == null) return
    let cur = /^\s*/.exec(line.text)![0]
    let norm = indentString(state, indent)
    if (cur != norm || range.from < line.from + cur.length) {
      updated[line.from] = indent
      changes.push({from: line.from, to: line.from + cur.length, insert: norm})
    }
  })
  if (!changes.changes!.empty) dispatch(state.update(changes))
  return true
}

/// Add a [unit](#language.indentUnit) of indentation to all selected
/// lines.
export const indentMore: StateCommand = ({state, dispatch}) => {
  dispatch(state.update(changeBySelectedLine(state, (line, changes) => {
    changes.push({from: line.from, insert: state.facet(indentUnit)})
  })))
  return true
}

/// Remove a [unit](#language.indentUnit) of indentation from all
/// selected lines.
export const indentLess: StateCommand = ({state, dispatch}) => {
  dispatch(state.update(changeBySelectedLine(state, (line, changes) => {
    let space = /^\s*/.exec(line.text)![0]
    if (!space) return
    let col = countColumn(space, 0, state.tabSize), keep = 0
    let insert = indentString(state, Math.max(0, col - getIndentUnit(state)))
    while (keep < space.length && keep < insert.length && space.charCodeAt(keep) == insert.charCodeAt(keep)) keep++
    changes.push({from: line.from + keep, to: line.from + space.length, insert: insert.slice(keep)})
  })))
  return true
}

/// Insert a tab character at the cursor or, if something is selected,
/// use [`indentMore`](#commands.indentMore) to indent the entire
/// selection.
export const insertTab: StateCommand = ({state, dispatch}) => {
  if (state.selection.ranges.some(r => !r.empty)) return indentMore({state, dispatch})
  dispatch(state.update(state.replaceSelection("\t"), {scrollIntoView: true, annotations: Transaction.userEvent.of("input")}))
  return true
}

/// Array of key bindings containing the Emacs-style bindings that are
/// available on macOS by default.
///
///  - Ctrl-b: [`cursorCharLeft`](#commands.cursorCharLeft) ([`selectCharLeft`](#commands.selectCharLeft) with Shift)
///  - Ctrl-f: [`cursorCharRight`](#commands.cursorCharRight) ([`selectCharRight`](#commands.selectCharRight) with Shift)
///  - Ctrl-p: [`cursorLineUp`](#commands.cursorLineUp) ([`selectLineUp`](#commands.selectLineUp) with Shift)
///  - Ctrl-n: [`cursorLineDown`](#commands.cursorLineDown) ([`selectLineDown`](#commands.selectLineDown) with Shift)
///  - Ctrl-a: [`cursorLineStart`](#commands.cursorLineStart) ([`selectLineStart`](#commands.selectLineStart) with Shift)
///  - Ctrl-e: [`cursorLineEnd`](#commands.cursorLineEnd) ([`selectLineEnd`](#commands.selectLineEnd) with Shift)
///  - Ctrl-d: [`deleteCharForward`](#commands.deleteCharForward)
///  - Ctrl-h: [`deleteCharBackward`](#commands.deleteCharBackward)
///  - Ctrl-k: [`deleteToLineEnd`](#commands.deleteToLineEnd)
///  - Alt-d: [`deleteGroupForward`](#commands.deleteGroupForward)
///  - Ctrl-Alt-h: [`deleteGroupBackward`](#commands.deleteGroupBackward)
///  - Ctrl-o: [`splitLine`](#commands.splitLine)
///  - Ctrl-t: [`transposeChars`](#commands.transposeChars)
///  - Alt-f: [`cursorGroupForward`](#commands.cursorGroupForward) ([`selectGroupForward`](#commands.selectGroupForward) with Shift)
///  - Alt-b: [`cursorGroupBackward`](#commands.cursorGroupBackward) ([`selectGroupBackward`](#commands.selectGroupBackward) with Shift)
///  - Alt-<: [`cursorDocStart`](#commands.cursorDocStart)
///  - Alt->: [`cursorDocEnd`](#commands.cursorDocEnd)
///  - Ctrl-v: [`cursorPageDown`](#commands.cursorPageDown)
///  - Alt-v: [`cursorPageUp`](#commands.cursorPageUp)
export const emacsStyleKeymap: readonly KeyBinding[] = [
  {key:"Ctrl-b", run: cursorCharLeft, shift: selectCharLeft},
  {key: "Ctrl-f", run: cursorCharRight, shift: selectCharRight},

  {key: "Ctrl-p", run: cursorLineUp, shift: selectLineUp},
  {key: "Ctrl-n", run: cursorLineDown, shift: selectLineDown},

  {key: "Ctrl-a", run: cursorLineStart, shift: selectLineStart},
  {key: "Ctrl-e", run: cursorLineEnd, shift: selectLineEnd},

  {key: "Ctrl-d", run: deleteCharForward},
  {key: "Ctrl-h", run: deleteCharBackward},
  {key: "Ctrl-k", run: deleteToLineEnd},
  {key: "Alt-d", run: deleteGroupForward},
  {key: "Ctrl-Alt-h", run: deleteGroupBackward},

  {key: "Ctrl-o", run: splitLine},
  {key: "Ctrl-t", run: transposeChars},

  {key: "Alt-f", run: cursorGroupForward, shift: selectGroupForward},
  {key: "Alt-b", run: cursorGroupBackward, shift: selectGroupBackward},

  {key: "Alt-<", run: cursorDocStart},
  {key: "Alt->", run: cursorDocEnd},

  {key: "Ctrl-v", run: cursorPageDown},
  {key: "Alt-v", run: cursorPageUp},
]

/// An array of key bindings closely sticking to platform-standard or
/// widely used bindings. (This includes the bindings from
/// [`emacsStyleKeymap`](#commands.emacsStyleKeymap), with their `key`
/// property changed to `mac`.)
///
///  - ArrowLeft: [`cursorCharLeft`](#commands.cursorCharLeft) ([`selectCharLeft`](#commands.selectCharLeft) with Shift)
///  - ArrowRight: [`cursorCharRight`](#commands.cursorCharRight) ([`selectCharRight`](#commands.selectCharRight) with Shift)
///  - Ctrl-ArrowLeft (Alt-ArrowLeft on macOS): [`cursorGroupLeft`](#commands.cursorGroupLeft) ([`selectGroupLeft`](#commands.selectGroupLeft) with Shift)
///  - Ctrl-ArrowRight (Alt-ArrowRight on macOS): [`cursorGroupRight`](#commands.cursorGroupRight) ([`selectGroupRight`](#commands.selectGroupRight) with Shift)
///  - Cmd-ArrowLeft (on macOS): [`cursorLineStart`](#commands.cursorLineStart) ([`selectLineStart`](#commands.selectLineStart) with Shift)
///  - Cmd-ArrowRight (on macOS): [`cursorLineEnd`](#commands.cursorLineEnd) ([`selectLineEnd`](#commands.selectLineEnd) with Shift)
///  - ArrowUp: [`cursorLineUp`](#commands.cursorLineUp) ([`selectLineUp`](#commands.selectLineUp) with Shift)
///  - ArrowDown: [`cursorLineDown`](#commands.cursorLineDown) ([`selectLineDown`](#commands.selectLineDown) with Shift)
///  - Cmd-ArrowUp (on macOS): [`cursorDocStart`](#commands.cursorDocStart) ([`selectDocStart`](#commands.selectDocStart) with Shift)
///  - Cmd-ArrowDown (on macOS): [`cursorDocEnd`](#commands.cursorDocEnd) ([`selectDocEnd`](#commands.selectDocEnd) with Shift)
///  - Ctrl-ArrowUp (on macOS): [`cursorPageUp`](#commands.cursorPageUp) ([`selectPageUp`](#commands.selectPageUp) with Shift)
///  - Ctrl-ArrowDown (on macOS): [`cursorPageDown`](#commands.cursorPageDown) ([`selectPageDown`](#commands.selectPageDown) with Shift)
///  - PageUp: [`cursorPageUp`](#commands.cursorPageUp) ([`selectPageUp`](#commands.selectPageUp) with Shift)
///  - PageDown: [`cursorPageDown`](#commands.cursorPageDown) ([`selectPageDown`](#commands.selectPageDown) with Shift)
///  - Home: [`cursorLineBoundaryBackward`](#commands.cursorLineBoundaryBackward) ([`selectLineBoundaryBackward`](#commands.selectLineBoundaryBackward) with Shift)
///  - End: [`cursorLineBoundaryForward`](#commands.cursorLineBoundaryForward) ([`selectLineBoundaryForward`](#commands.selectLineBoundaryForward) with Shift)
///  - Ctrl-Home (Cmd-Home on macOS): [`cursorDocStart`](#commands.cursorDocStart) ([`selectDocStart`](#commands.selectDocStart) with Shift)
///  - Ctrl-End (Cmd-Home on macOS): [`cursorDocEnd`](#commands.cursorDocEnd) ([`selectDocEnd`](#commands.selectDocEnd) with Shift)
///  - Enter: [`insertNewlineAndIndent`](#commands.insertNewlineAndIndent)
///  - Ctrl-a (Cmd-a on macOS): [`selectAll`](#commands.selectAll)
///  - Backspace: [`deleteCodePointBackward`](#commands.deleteCodePointBackward)
///  - Delete: [`deleteCharForward`](#commands.deleteCharForward)
///  - Ctrl-Backspace (Alt-Backspace on macOS): [`deleteGroupBackward`](#commands.deleteGroupBackward)
///  - Ctrl-Delete (Alt-Delete on macOS): [`deleteGroupForward`](#commands.deleteGroupForward)
///  - Cmd-Backspace (macOS): [`deleteToLineStart`](#commands.deleteToLineStart).
///  - Cmd-Delete (macOS): [`deleteToLineEnd`](#commands.deleteToLineEnd).
export const standardKeymap: readonly KeyBinding[] = ([
  {key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft},
  {key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: cursorGroupLeft, shift: selectGroupLeft},
  {mac: "Cmd-ArrowLeft", run: cursorLineStart, shift: selectLineStart},

  {key: "ArrowRight", run: cursorCharRight, shift: selectCharRight},
  {key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: cursorGroupRight, shift: selectGroupRight},
  {mac: "Cmd-ArrowRight", run: cursorLineEnd, shift: selectLineEnd},

  {key: "ArrowUp", run: cursorLineUp, shift: selectLineUp},
  {mac: "Cmd-ArrowUp", run: cursorDocStart, shift: selectDocStart},
  {mac: "Ctrl-ArrowUp", run: cursorPageUp, shift: selectPageUp},

  {key: "ArrowDown", run: cursorLineDown, shift: selectLineDown},
  {mac: "Cmd-ArrowDown", run: cursorDocEnd, shift: selectDocEnd},
  {mac: "Ctrl-ArrowDown", run: cursorPageDown, shift: selectPageDown},

  {key: "PageUp", run: cursorPageUp, shift: selectPageUp},
  {key: "PageDown", run: cursorPageDown, shift: selectPageDown},

  {key: "Home", run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward},
  {key: "Mod-Home", run: cursorDocStart, shift: selectDocStart},

  {key: "End", run: cursorLineBoundaryForward, shift: selectLineBoundaryForward},
  {key: "Mod-End", run: cursorDocEnd, shift: selectDocEnd},

  {key: "Enter", run: insertNewlineAndIndent},

  {key: "Mod-a", run: selectAll},

  {key: "Backspace", run: deleteCodePointBackward, shift: deleteCodePointBackward},
  {key: "Delete", run: deleteCharForward, shift: deleteCharForward},
  {key: "Mod-Backspace", mac: "Alt-Backspace", run: deleteGroupBackward},
  {key: "Mod-Delete", mac: "Alt-Delete", run: deleteGroupForward},
  {mac: "Mod-Backspace", run: deleteToLineStart},
  {mac: "Mod-Delete", run: deleteToLineEnd}
] as KeyBinding[]).concat(emacsStyleKeymap.map(b => ({mac: b.key, run: b.run, shift: b.shift})))

/// The default keymap. Includes all bindings from
/// [`standardKeymap`](#commands.standardKeymap) plus the following:
///
/// - Alt-ArrowLeft (Ctrl-ArrowLeft on macOS): [`cursorSyntaxLeft`](#commands.cursorSyntaxLeft) ([`selectSyntaxLeft`](#commands.selectSyntaxLeft) with Shift)
/// - Alt-ArrowRight (Ctrl-ArrowRight on macOS): [`cursorSyntaxRight`](#commands.cursorSyntaxRight) ([`selectSyntaxRight`](#commands.selectSyntaxRight) with Shift)
/// - Alt-ArrowUp: [`moveLineUp`](#commands.moveLineUp)
/// - Alt-ArrowDown: [`moveLineDown`](#commands.moveLineDown)
/// - Shift-Alt-ArrowUp: [`copyLineUp`](#commands.copyLineUp)
/// - Shift-Alt-ArrowDown: [`copyLineDown`](#commands.copyLineDown)
/// - Escape: [`simplifySelection`](#commands.simplifySelection)
/// - Alt-l: [`selectLine`](#commands.selectLine)
/// - Ctrl-i (Cmd-i on macOS): [`selectParentSyntax`](#commands.selectParentSyntax)
/// - Ctrl-[ (Cmd-[ on macOS): [`indentLess`](#commands.indentLess)
/// - Ctrl-] (Cmd-] on macOS): [`indentMore`](#commands.indentMore)
/// - Ctrl-Alt-\\ (Cmd-Alt-\\ on macOS): [`indentSelection`](#commands.indentSelection)
/// - Shift-Ctrl-k (Shift-Cmd-k on macOS): [`deleteLine`](#commands.deleteLine)
/// - Shift-Ctrl-\\ (Shift-Cmd-\\ on macOS): [`cursorMatchingBracket`](#commands.cursorMatchingBracket)
export const defaultKeymap: readonly KeyBinding[] = ([
  {key: "Alt-ArrowLeft", mac: "Ctrl-ArrowLeft", run: cursorSyntaxLeft, shift: selectSyntaxLeft},
  {key: "Alt-ArrowRight", mac: "Ctrl-ArrowRight", run: cursorSyntaxRight, shift: selectSyntaxRight},

  {key: "Alt-ArrowUp", run: moveLineUp},
  {key: "Shift-Alt-ArrowUp", run: copyLineUp},

  {key: "Alt-ArrowDown", run: moveLineDown},
  {key: "Shift-Alt-ArrowDown", run: copyLineDown},

  {key: "Escape", run: simplifySelection},

  {key: "Alt-l", run: selectLine},
  {key: "Mod-i", run: selectParentSyntax},

  {key: "Mod-[", run: indentLess},
  {key: "Mod-]", run: indentMore},
  {key: "Mod-Alt-\\", run: indentSelection},

  {key: "Shift-Mod-k", run: deleteLine},

  {key: "Shift-Mod-\\", run: cursorMatchingBracket},

  {key: "Mod-d", run: selectNextOccurrence},
] as readonly KeyBinding[]).concat(standardKeymap)

/// A binding that binds Tab to [`insertTab`](#commands.insertTab) and
/// Shift-Tab to [`indentSelection`](#commands.indentSelection).
/// Please see the [Tab example](../../examples/tab/) before using
/// this.
export const defaultTabBinding: KeyBinding =
  {key: "Tab", run: insertTab, shift: indentSelection}
