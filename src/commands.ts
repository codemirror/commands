import {EditorState, StateCommand, EditorSelection, SelectionRange,
        ChangeSpec, Transaction, CharCategory,
        findClusterBreak, Text, Line, countColumn} from "@codemirror/state"
import {EditorView, Command, Direction, KeyBinding} from "@codemirror/view"
import {syntaxTree, IndentContext, getIndentUnit, indentUnit, indentString,
        getIndentation, matchBrackets} from "@codemirror/language"
import {SyntaxNode, NodeProp} from "@lezer/common"
import {toggleComment, toggleBlockComment} from "./comment"

export {CommentTokens, toggleComment, toggleLineComment, lineComment, lineUncomment,
        toggleBlockComment, blockComment, blockUncomment, toggleBlockCommentByLine} from "./comment"
export {history, historyKeymap, historyField, undo, redo, undoSelection, redoSelection,
        undoDepth, redoDepth, isolateHistory, invertedEffects} from "./history"

function updateSel(sel: EditorSelection, by: (range: SelectionRange) => SelectionRange) {
  return EditorSelection.create(sel.ranges.map(by), sel.mainIndex)
}

function setSel(state: EditorState, selection: EditorSelection | {anchor: number, head?: number}) {
  return state.update({selection, scrollIntoView: true, userEvent: "select"})
}

type CommandTarget = {state: EditorState, dispatch: (tr: Transaction) => void}

function moveSel({state, dispatch}: CommandTarget,
                 how: (range: SelectionRange) => SelectionRange): boolean {
  let selection = updateSel(state.selection, how)
  if (selection.eq(state.selection, true)) return false
  dispatch(setSel(state, selection))
  return true
}

function rangeEnd(range: SelectionRange, forward: boolean) {
  return EditorSelection.cursor(forward ? range.to : range.from)
}

function cursorByChar(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? view.moveByChar(range, forward) : rangeEnd(range, forward))
}

function ltrAtCursor(view: EditorView) {
  return view.textDirectionAt(view.state.selection.main.head) == Direction.LTR
}

/// Move the selection one character to the left (which is backward in
/// left-to-right text, forward in right-to-left text).
export const cursorCharLeft: Command = view => cursorByChar(view, !ltrAtCursor(view))
/// Move the selection one character to the right.
export const cursorCharRight: Command = view => cursorByChar(view, ltrAtCursor(view))

/// Move the selection one character forward.
export const cursorCharForward: Command = view => cursorByChar(view, true)
/// Move the selection one character backward.
export const cursorCharBackward: Command = view => cursorByChar(view, false)

function cursorByGroup(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? view.moveByGroup(range, forward) : rangeEnd(range, forward))
}

/// Move the selection to the left across one group of word or
/// non-word (but also non-space) characters.
export const cursorGroupLeft: Command = view => cursorByGroup(view, !ltrAtCursor(view))
/// Move the selection one group to the right.
export const cursorGroupRight: Command = view => cursorByGroup(view, ltrAtCursor(view))

/// Move the selection one group forward.
export const cursorGroupForward: Command = view => cursorByGroup(view, true)
/// Move the selection one group backward.
export const cursorGroupBackward: Command = view => cursorByGroup(view, false)

const segmenter = typeof Intl != "undefined" && (Intl as any).Segmenter ?
  new ((Intl as any).Segmenter)(undefined, {granularity: "word"}) : null

function moveBySubword(view: EditorView, range: SelectionRange, forward: boolean) {
  let categorize = view.state.charCategorizer(range.from)
  let cat = CharCategory.Space, pos = range.from, steps = 0
  let done = false, sawUpper = false, sawLower = false
  let step = (next: string) => {
    if (done) return false
    pos += forward ? next.length : -next.length
    let nextCat = categorize(next), ahead
    if (nextCat == CharCategory.Word && next.charCodeAt(0) < 128 && /[\W_]/.test(next))
      nextCat = -1 as any // Treat word punctuation specially
    if (cat == CharCategory.Space) cat = nextCat
    if (cat != nextCat) return false
    if (cat == CharCategory.Word) {
      if (next.toLowerCase() == next) {
        if (!forward && sawUpper) return false
        sawLower = true
      } else if (sawLower) {
        if (forward) return false
        done = true
      } else {
        if (sawUpper && forward && categorize(ahead = view.state.sliceDoc(pos, pos + 1)) == CharCategory.Word &&
          ahead.toLowerCase() == ahead) return false
        sawUpper = true
      }
    }
    steps++
    return true
  }

  let end = view.moveByChar(range, forward, start => {
    step(start)
    return step
  })

  if (segmenter && cat == CharCategory.Word as any && end.from == range.from + steps * (forward ? 1 : -1)) {
    let from = Math.min(range.head, end.head), to = Math.max(range.head, end.head)
    let skipped = view.state.sliceDoc(from, to)
    if (skipped.length > 1 && /[\u4E00-\uffff]/.test(skipped)) {
      let segments = Array.from(segmenter.segment(skipped)) as {index: number}[]
      if (segments.length > 1) {
        if (forward) return EditorSelection.cursor(range.head + segments[1].index, -1)
        return EditorSelection.cursor(end.head + segments[segments.length - 1].index, 1)
      }
    }
  }
  return end
}

function cursorBySubword(view: EditorView, forward: boolean) {
  return moveSel(view, range => range.empty ? moveBySubword(view, range, forward) : rangeEnd(range, forward))
}

/// Move the selection one group or camel-case subword forward.
export const cursorSubwordForward: Command = view => cursorBySubword(view, true)
/// Move the selection one group or camel-case subword backward.
export const cursorSubwordBackward: Command = view => cursorBySubword(view, false)

function interestingNode(state: EditorState, node: SyntaxNode, bracketProp: NodeProp<unknown>) {
  if (node.type.prop(bracketProp)) return true
  let len = node.to - node.from
  return len && (len > 2 || /[^\s,.;:]/.test(state.sliceDoc(node.from, node.to))) || node.firstChild
}

function moveBySyntax(state: EditorState, start: SelectionRange, forward: boolean) {
  let pos = syntaxTree(state).resolveInner(start.head)
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
  view => moveSel(view, range => moveBySyntax(view.state, range, !ltrAtCursor(view)))
/// Move the cursor over the next syntactic element to the right.
export const cursorSyntaxRight: Command =
  view => moveSel(view, range => moveBySyntax(view.state, range, ltrAtCursor(view)))

function cursorByLine(view: EditorView, forward: boolean) {
  return moveSel(view, range => {
    if (!range.empty) return rangeEnd(range, forward)
    let moved = view.moveVertically(range, forward)
    return moved.head != range.head ? moved : view.moveToLineBoundary(range, forward)
  })
}

/// Move the selection one line up.
export const cursorLineUp: Command = view => cursorByLine(view, false)
/// Move the selection one line down.
export const cursorLineDown: Command = view => cursorByLine(view, true)

function pageInfo(view: EditorView) {
  let selfScroll = view.scrollDOM.clientHeight < view.scrollDOM.scrollHeight - 2
  let marginTop = 0, marginBottom = 0, height
  if (selfScroll) {
    for (let source of view.state.facet(EditorView.scrollMargins)) {
      let margins = source(view)
      if (margins?.top) marginTop = Math.max(margins?.top, marginTop)
      if (margins?.bottom) marginBottom = Math.max(margins?.bottom, marginBottom)
    }
    height = view.scrollDOM.clientHeight - marginTop - marginBottom
  } else {
    height = (view.dom.ownerDocument.defaultView || window).innerHeight
  }
  return {marginTop, marginBottom, selfScroll,
          height: Math.max(view.defaultLineHeight, height - 5)}
}

function cursorByPage(view: EditorView, forward: boolean) {
  let page = pageInfo(view)
  let {state} = view, selection = updateSel(state.selection, range => {
    return range.empty ? view.moveVertically(range, forward, page.height)
      : rangeEnd(range, forward)
  })
  if (selection.eq(state.selection)) return false
  let effect
  if (page.selfScroll) {
    let startPos = view.coordsAtPos(state.selection.main.head)
    let scrollRect = view.scrollDOM.getBoundingClientRect()
    let scrollTop = scrollRect.top + page.marginTop, scrollBottom = scrollRect.bottom - page.marginBottom
    if (startPos && startPos.top > scrollTop && startPos.bottom < scrollBottom)
      effect = EditorView.scrollIntoView(selection.main.head, {y: "start", yMargin: startPos.top - scrollTop})
  }
  view.dispatch(setSel(state, selection), {effects: effect})
  return true
}

/// Move the selection one page up.
export const cursorPageUp: Command = view => cursorByPage(view, false)
/// Move the selection one page down.
export const cursorPageDown: Command = view => cursorByPage(view, true)

function moveByLineBoundary(view: EditorView, start: SelectionRange, forward: boolean) {
  let line = view.lineBlockAt(start.head), moved = view.moveToLineBoundary(start, forward)
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
/// Move the selection one line wrap point to the left.
export const cursorLineBoundaryLeft: Command = view => moveSel(view, range =>
  moveByLineBoundary(view, range, !ltrAtCursor(view)))
/// Move the selection one line wrap point to the right.
export const cursorLineBoundaryRight: Command = view => moveSel(view, range =>
  moveByLineBoundary(view, range, ltrAtCursor(view)))

/// Move the selection to the start of the line.
export const cursorLineStart: Command = view => moveSel(view, range => EditorSelection.cursor(view.lineBlockAt(range.head).from, 1))
/// Move the selection to the end of the line.
export const cursorLineEnd: Command = view => moveSel(view, range => EditorSelection.cursor(view.lineBlockAt(range.head).to, -1))

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
    return EditorSelection.range(range.anchor, head.head, head.goalColumn, head.bidiLevel || undefined)
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
export const selectCharLeft: Command = view => selectByChar(view, !ltrAtCursor(view))
/// Move the selection head one character to the right.
export const selectCharRight: Command = view => selectByChar(view, ltrAtCursor(view))

/// Move the selection head one character forward.
export const selectCharForward: Command = view => selectByChar(view, true)
/// Move the selection head one character backward.
export const selectCharBackward: Command = view => selectByChar(view, false)

function selectByGroup(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveByGroup(range, forward))
}

/// Move the selection head one [group](#commands.cursorGroupLeft) to
/// the left.
export const selectGroupLeft: Command = view => selectByGroup(view, !ltrAtCursor(view))
/// Move the selection head one group to the right.
export const selectGroupRight: Command = view => selectByGroup(view, ltrAtCursor(view))

/// Move the selection head one group forward.
export const selectGroupForward: Command = view => selectByGroup(view, true)
/// Move the selection head one group backward.
export const selectGroupBackward: Command = view => selectByGroup(view, false)

function selectBySubword(view: EditorView, forward: boolean) {
  return extendSel(view, range => moveBySubword(view, range, forward))
}

/// Move the selection head one group or camel-case subword forward.
export const selectSubwordForward: Command = view => selectBySubword(view, true)
/// Move the selection head one group or subword backward.
export const selectSubwordBackward: Command = view => selectBySubword(view, false)

/// Move the selection head over the next syntactic element to the left.
export const selectSyntaxLeft: Command =
  view => extendSel(view, range => moveBySyntax(view.state, range, !ltrAtCursor(view)))
/// Move the selection head over the next syntactic element to the right.
export const selectSyntaxRight: Command =
  view => extendSel(view, range => moveBySyntax(view.state, range, ltrAtCursor(view)))

function selectByLine(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveVertically(range, forward))
}

/// Move the selection head one line up.
export const selectLineUp: Command = view => selectByLine(view, false)
/// Move the selection head one line down.
export const selectLineDown: Command = view => selectByLine(view, true)

function selectByPage(view: EditorView, forward: boolean) {
  return extendSel(view, range => view.moveVertically(range, forward, pageInfo(view).height))
}

/// Move the selection head one page up.
export const selectPageUp: Command = view => selectByPage(view, false)
/// Move the selection head one page down.
export const selectPageDown: Command = view => selectByPage(view, true)

/// Move the selection head to the next line boundary.
export const selectLineBoundaryForward: Command = view => extendSel(view, range => moveByLineBoundary(view, range, true))
/// Move the selection head to the previous line boundary.
export const selectLineBoundaryBackward: Command = view => extendSel(view, range => moveByLineBoundary(view, range, false))
/// Move the selection head one line boundary to the left.
export const selectLineBoundaryLeft: Command = view => extendSel(view, range =>
  moveByLineBoundary(view, range, !ltrAtCursor(view)))
/// Move the selection head one line boundary to the right.
export const selectLineBoundaryRight: Command = view => extendSel(view, range =>
  moveByLineBoundary(view, range, ltrAtCursor(view)))

/// Move the selection head to the start of the line.
export const selectLineStart: Command = view => extendSel(view, range => EditorSelection.cursor(view.lineBlockAt(range.head).from))
/// Move the selection head to the end of the line.
export const selectLineEnd: Command = view => extendSel(view, range => EditorSelection.cursor(view.lineBlockAt(range.head).to))

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
  dispatch(state.update({selection: {anchor: 0, head: state.doc.length}, userEvent: "select"}))
  return true
}

/// Expand the selection to cover entire lines.
export const selectLine: StateCommand = ({state, dispatch}) => {
  let ranges = selectedLineBlocks(state).map(({from, to}) => EditorSelection.range(from, Math.min(to + 1, state.doc.length)))
  dispatch(state.update({selection: EditorSelection.create(ranges), userEvent: "select"}))
  return true
}

/// Select the next syntactic construct that is larger than the
/// selection. Note that this will only work insofar as the language
/// [provider](#language.language) you use builds up a full
/// syntax tree.
export const selectParentSyntax: StateCommand = ({state, dispatch}) => {
  let selection = updateSel(state.selection, range => {
    let tree = syntaxTree(state), stack = tree.resolveStack(range.from, 1)
    if (range.empty) {
      let stackBefore = tree.resolveStack(range.from, -1)
      if (stackBefore.node.from >= stack.node.from && stackBefore.node.to <= stack.node.to) stack = stackBefore
    }
    for (let cur: typeof stack | null = stack; cur; cur = cur.next) {
      let {node} = cur
      if (((node.from < range.from && node.to >= range.to) ||
           (node.to > range.to && node.from <= range.from)) &&
           cur.next)
        return EditorSelection.range(node.to, node.from)
    }
    return range
  })
  if (selection.eq(state.selection)) return false
  dispatch(setSel(state, selection))
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

function deleteBy(target: CommandTarget, by: (start: SelectionRange) => number) {
  if (target.state.readOnly) return false
  let event = "delete.selection", {state} = target
  let changes = state.changeByRange(range => {
    let {from, to} = range
    if (from == to) {
      let towards = by(range)
      if (towards < from) {
        event = "delete.backward"
        towards = skipAtomic(target, towards, false)
      } else if (towards > from) {
        event = "delete.forward"
        towards = skipAtomic(target, towards, true)
      }
      from = Math.min(from, towards)
      to = Math.max(to, towards)
    } else {
      from = skipAtomic(target, from, false)
      to = skipAtomic(target, to, true)
    }
    return from == to ? {range} : {changes: {from, to}, range: EditorSelection.cursor(from, from < range.head ? -1 : 1)}
  })
  if (changes.changes.empty) return false
  target.dispatch(state.update(changes, {
    scrollIntoView: true,
    userEvent: event,
    effects: event == "delete.selection" ? EditorView.announce.of(state.phrase("Selection deleted")) : undefined
  }))
  return true
}

function skipAtomic(target: CommandTarget, pos: number, forward: boolean) {
  if (target instanceof EditorView) for (let ranges of target.state.facet(EditorView.atomicRanges).map(f => f(target)))
    ranges.between(pos, pos, (from, to) => {
      if (from < pos && to > pos) pos = forward ? to : from
    })
  return pos
}

const deleteByChar = (target: CommandTarget, forward: boolean, byIndentUnit: boolean) => deleteBy(target, range => {
  let pos = range.from, {state} = target, line = state.doc.lineAt(pos), before, targetPos: number
  if (byIndentUnit && !forward && pos > line.from && pos < line.from + 200 &&
      !/[^ \t]/.test(before = line.text.slice(0, pos - line.from))) {
    if (before[before.length - 1] == "\t") return pos - 1
    let col = countColumn(before, state.tabSize), drop = col % getIndentUnit(state) || getIndentUnit(state)
    for (let i = 0; i < drop && before[before.length - 1 - i] == " "; i++) pos--
    targetPos = pos
  } else {
    targetPos = findClusterBreak(line.text, pos - line.from, forward, forward) + line.from
    if (targetPos == pos && line.number != (forward ? state.doc.lines : 1))
      targetPos += forward ? 1 : -1
    else if (!forward && /[\ufe00-\ufe0f]/.test(line.text.slice(targetPos - line.from, pos - line.from)))
      targetPos = findClusterBreak(line.text, targetPos - line.from, false, false) + line.from
  }
  return targetPos
})

/// Delete the selection, or, for cursor selections, the character or
/// indentation unit before the cursor.
export const deleteCharBackward: Command = view => deleteByChar(view, false, true)

/// Delete the selection or the character before the cursor. Does not
/// implement any extended behavior like deleting whole indentation
/// units in one go.
export const deleteCharBackwardStrict: Command = view => deleteByChar(view, false, false)

/// Delete the selection or the character after the cursor.
export const deleteCharForward: Command = view => deleteByChar(view, true, false)

const deleteByGroup = (target: CommandTarget, forward: boolean) => deleteBy(target, range => {
  let pos = range.head, {state} = target, line = state.doc.lineAt(pos)
  let categorize = state.charCategorizer(pos)
  for (let cat: CharCategory | null = null;;) {
    if (pos == (forward ? line.to : line.from)) {
      if (pos == range.head && line.number != (forward ? state.doc.lines : 1))
        pos += forward ? 1 : -1
      break
    }
    let next = findClusterBreak(line.text, pos - line.from, forward) + line.from
    let nextChar = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from)
    let nextCat = categorize(nextChar)
    if (cat != null && nextCat != cat) break
    if (nextChar != " " || pos != range.head) cat = nextCat
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
export const deleteToLineEnd: Command = view => deleteBy(view, range => {
  let lineEnd = view.lineBlockAt(range.head).to
  return range.head < lineEnd ? lineEnd : Math.min(view.state.doc.length, range.head + 1)
})

/// Delete the selection, or, if it is a cursor selection, delete to
/// the start of the line. If the cursor is directly at the start of the
/// line, delete the line break before it.
export const deleteToLineStart: Command = view => deleteBy(view, range => {
  let lineStart = view.lineBlockAt(range.head).from
  return range.head > lineStart ? lineStart : Math.max(0, range.head - 1)
})

/// Delete the selection, or, if it is a cursor selection, delete to
/// the start of the line or the next line wrap before the cursor.
export const deleteLineBoundaryBackward: Command = view => deleteBy(view, range => {
  let lineStart = view.moveToLineBoundary(range, false).head
  return range.head > lineStart ? lineStart : Math.max(0, range.head - 1)
})

/// Delete the selection, or, if it is a cursor selection, delete to
/// the end of the line or the next line wrap after the cursor.
export const deleteLineBoundaryForward: Command = view => deleteBy(view, range => {
  let lineStart = view.moveToLineBoundary(range, true).head
  return range.head < lineStart ? lineStart : Math.min(view.state.doc.length, range.head + 1)
})

/// Delete all whitespace directly before a line end from the
/// document.
export const deleteTrailingWhitespace: StateCommand = ({state, dispatch}) => {
  if (state.readOnly) return false
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
  dispatch(state.update({changes, userEvent: "delete"}))
  return true
}

/// Replace each selection range with a line break, leaving the cursor
/// on the line before the break.
export const splitLine: StateCommand = ({state, dispatch}) => {
  if (state.readOnly) return false
  let changes = state.changeByRange(range => {
    return {changes: {from: range.from, to: range.to, insert: Text.of(["", ""])},
            range: EditorSelection.cursor(range.from)}
  })
  dispatch(state.update(changes, {scrollIntoView: true, userEvent: "input"}))
  return true
}

/// Flip the characters before and after the cursor(s).
export const transposeChars: StateCommand = ({state, dispatch}) => {
  if (state.readOnly) return false
  let changes = state.changeByRange(range => {
    if (!range.empty || range.from == 0 || range.from == state.doc.length) return {range}
    let pos = range.from, line = state.doc.lineAt(pos)
    let from = pos == line.from ? pos - 1 : findClusterBreak(line.text, pos - line.from, false) + line.from
    let to = pos == line.to ? pos + 1 : findClusterBreak(line.text, pos - line.from, true) + line.from
    return {changes: {from, to, insert: state.doc.slice(pos, to).append(state.doc.slice(from, pos))},
            range: EditorSelection.cursor(to)}
  })
  if (changes.changes.empty) return false
  dispatch(state.update(changes, {scrollIntoView: true, userEvent: "move.character"}))
  return true
}

function selectedLineBlocks(state: EditorState) {
  let blocks = [], upto = -1
  for (let range of state.selection.ranges) {
    let startLine = state.doc.lineAt(range.from), endLine = state.doc.lineAt(range.to)
    if (!range.empty && range.to == endLine.from) endLine = state.doc.lineAt(range.to - 1)
    if (upto >= startLine.number) {
      let prev = blocks[blocks.length - 1]
      prev.to = endLine.to
      prev.ranges.push(range)
    } else {
      blocks.push({from: startLine.from, to: endLine.to, ranges: [range]})
    }
    upto = endLine.number + 1
  }
  return blocks
}

function moveLine(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean): boolean {
  if (state.readOnly) return false
  let changes = [], ranges = []
  for (let block of selectedLineBlocks(state)) {
    if (forward ? block.to == state.doc.length : block.from == 0) continue
    let nextLine = state.doc.lineAt(forward ? block.to + 1 : block.from - 1)
    let size = nextLine.length + 1
    if (forward) {
      changes.push({from: block.to, to: nextLine.to},
                   {from: block.from, insert: nextLine.text + state.lineBreak})
      for (let r of block.ranges)
        ranges.push(EditorSelection.range(Math.min(state.doc.length, r.anchor + size), Math.min(state.doc.length, r.head + size)))
    } else {
      changes.push({from: nextLine.from, to: block.from},
                   {from: block.to, insert: state.lineBreak + nextLine.text})
      for (let r of block.ranges)
        ranges.push(EditorSelection.range(r.anchor - size, r.head - size))
    }
  }
  if (!changes.length) return false
  dispatch(state.update({
    changes,
    scrollIntoView: true,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    userEvent: "move.line"
  }))
  return true
}

/// Move the selected lines up one line.
export const moveLineUp: StateCommand = ({state, dispatch}) => moveLine(state, dispatch, false)
/// Move the selected lines down one line.
export const moveLineDown: StateCommand = ({state, dispatch}) => moveLine(state, dispatch, true)

function copyLine(state: EditorState, dispatch: (tr: Transaction) => void, forward: boolean): boolean {
  if (state.readOnly) return false
  let changes = []
  for (let block of selectedLineBlocks(state)) {
    if (forward)
      changes.push({from: block.from, insert: state.doc.slice(block.from, block.to) + state.lineBreak})
    else
      changes.push({from: block.to, insert: state.lineBreak + state.doc.slice(block.from, block.to)})
  }
  dispatch(state.update({changes, scrollIntoView: true, userEvent: "input.copyline"}))
  return true
}

/// Create a copy of the selected lines. Keep the selection in the top copy.
export const copyLineUp: StateCommand = ({state, dispatch}) => copyLine(state, dispatch, false)
/// Create a copy of the selected lines. Keep the selection in the bottom copy.
export const copyLineDown: StateCommand = ({state, dispatch}) => copyLine(state, dispatch, true)

/// Delete selected lines.
export const deleteLine: Command = view => {
  if (view.state.readOnly) return false
  let {state} = view, changes = state.changes(selectedLineBlocks(state).map(({from, to}) => {
    if (from > 0) from--
    else if (to < state.doc.length) to++
    return {from, to}
  }))
  let selection = updateSel(state.selection, range => {
    let dist: number | undefined = undefined
    if (view.lineWrapping) {
      let block = view.lineBlockAt(range.head), pos = view.coordsAtPos(range.head, range.assoc || 1)
      if (pos) dist = (block.bottom + view.documentTop) - pos.bottom + view.defaultLineHeight / 2
    }
    return view.moveVertically(range, true, dist)
  }).map(changes)
  view.dispatch({changes, selection, scrollIntoView: true, userEvent: "delete.line"})
  return true
}

/// Replace the selection with a newline.
export const insertNewline: StateCommand = ({state, dispatch}) => {
  dispatch(state.update(state.replaceSelection(state.lineBreak), {scrollIntoView: true, userEvent: "input"}))
  return true
}

/// Replace the selection with a newline and the same amount of
/// indentation as the line above.
export const insertNewlineKeepIndent: StateCommand = ({state, dispatch}) => {
  dispatch(state.update(state.changeByRange(range => {
    let indent = /^\s*/.exec(state.doc.lineAt(range.from).text)![0]
    return {
      changes: {from: range.from, to: range.to, insert: state.lineBreak + indent},
      range: EditorSelection.cursor(range.from + indent.length + 1)
    }
  }), {scrollIntoView: true, userEvent: "input"}))
  return true
}

function isBetweenBrackets(state: EditorState, pos: number): {from: number, to: number} | null {
  if (/\(\)|\[\]|\{\}/.test(state.sliceDoc(pos - 1, pos + 1))) return {from: pos, to: pos}
  let context = syntaxTree(state).resolveInner(pos)
  let before = context.childBefore(pos), after = context.childAfter(pos), closedBy
  if (before && after && before.to <= pos && after.from >= pos &&
      (closedBy = before.type.prop(NodeProp.closedBy)) && closedBy.indexOf(after.name) > -1 &&
      state.doc.lineAt(before.to).from == state.doc.lineAt(after.from).from &&
      !/\S/.test(state.sliceDoc(before.to, after.from)))
    return {from: before.to, to: after.from}
  return null
}

/// Replace the selection with a newline and indent the newly created
/// line(s). If the current line consists only of whitespace, this
/// will also delete that whitespace. When the cursor is between
/// matching brackets, an additional newline will be inserted after
/// the cursor.
export const insertNewlineAndIndent = newlineAndIndent(false)

/// Create a blank, indented line below the current line.
export const insertBlankLine = newlineAndIndent(true)

function newlineAndIndent(atEof: boolean): StateCommand {
  return ({state, dispatch}): boolean => {
    if (state.readOnly) return false
    let changes = state.changeByRange(range => {
      let {from, to} = range, line = state.doc.lineAt(from)
      let explode = !atEof && from == to && isBetweenBrackets(state, from)
      if (atEof) from = to = (to <= line.to ? line : state.doc.lineAt(to)).to
      let cx = new IndentContext(state, {simulateBreak: from, simulateDoubleBreak: !!explode})
      let indent = getIndentation(cx, from)
      if (indent == null)
        indent = countColumn(/^\s*/.exec(state.doc.lineAt(from).text)![0], state.tabSize)

      while (to < line.to && /\s/.test(line.text[to - line.from])) to++
      if (explode) ({from, to} = explode)
      else if (from > line.from && from < line.from + 100 && !/\S/.test(line.text.slice(0, from))) from = line.from
      let insert = ["", indentString(state, indent)]
      if (explode) insert.push(indentString(state, cx.lineIndent(line.from, -1)))
      return {changes: {from, to, insert: Text.of(insert)},
              range: EditorSelection.cursor(from + 1 + insert[1].length)}
    })
    dispatch(state.update(changes, {scrollIntoView: true, userEvent: "input"}))
    return true
  }
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
  if (state.readOnly) return false
  let updated: {[lineStart: number]: number} = Object.create(null)
  let context = new IndentContext(state, {overrideIndentation: start => {
    let found = updated[start]
    return found == null ? -1 : found
  }})
  let changes = changeBySelectedLine(state, (line, changes, range) => {
    let indent = getIndentation(context, line.from)
    if (indent == null) return
    if (!/\S/.test(line.text)) indent = 0
    let cur = /^\s*/.exec(line.text)![0]
    let norm = indentString(state, indent)
    if (cur != norm || range.from < line.from + cur.length) {
      updated[line.from] = indent
      changes.push({from: line.from, to: line.from + cur.length, insert: norm})
    }
  })
  if (!changes.changes!.empty) dispatch(state.update(changes, {userEvent: "indent"}))
  return true
}

/// Add a [unit](#language.indentUnit) of indentation to all selected
/// lines.
export const indentMore: StateCommand = ({state, dispatch}) => {
  if (state.readOnly) return false
  dispatch(state.update(changeBySelectedLine(state, (line, changes) => {
    changes.push({from: line.from, insert: state.facet(indentUnit)})
  }), {userEvent: "input.indent"}))
  return true
}

/// Remove a [unit](#language.indentUnit) of indentation from all
/// selected lines.
export const indentLess: StateCommand = ({state, dispatch}) => {
  if (state.readOnly) return false
  dispatch(state.update(changeBySelectedLine(state, (line, changes) => {
    let space = /^\s*/.exec(line.text)![0]
    if (!space) return
    let col = countColumn(space, state.tabSize), keep = 0
    let insert = indentString(state, Math.max(0, col - getIndentUnit(state)))
    while (keep < space.length && keep < insert.length && space.charCodeAt(keep) == insert.charCodeAt(keep)) keep++
    changes.push({from: line.from + keep, to: line.from + space.length, insert: insert.slice(keep)})
  }), {userEvent: "delete.dedent"}))
  return true
}

/// Enables or disables
/// [tab-focus mode](#view.EditorView.setTabFocusMode). While on, this
/// prevents the editor's key bindings from capturing Tab or
/// Shift-Tab, making it possible for the user to move focus out of
/// the editor with the keyboard.
export const toggleTabFocusMode: Command = view => {
  view.setTabFocusMode()
  return true
}

/// Temporarily enables [tab-focus
/// mode](#view.EditorView.setTabFocusMode) for two seconds or until
/// another key is pressed.
export const temporarilySetTabFocusMode: Command = view => {
  view.setTabFocusMode(2000)
  return true
}

/// Insert a tab character at the cursor or, if something is selected,
/// use [`indentMore`](#commands.indentMore) to indent the entire
/// selection.
export const insertTab: StateCommand = ({state, dispatch}) => {
  if (state.selection.ranges.some(r => !r.empty)) return indentMore({state, dispatch})
  dispatch(state.update(state.replaceSelection("\t"), {scrollIntoView: true, userEvent: "input"}))
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
///  - Ctrl-Alt-h: [`deleteGroupBackward`](#commands.deleteGroupBackward)
///  - Ctrl-o: [`splitLine`](#commands.splitLine)
///  - Ctrl-t: [`transposeChars`](#commands.transposeChars)
///  - Ctrl-v: [`cursorPageDown`](#commands.cursorPageDown)
///  - Alt-v: [`cursorPageUp`](#commands.cursorPageUp)
export const emacsStyleKeymap: readonly KeyBinding[] = [
  {key: "Ctrl-b", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true},
  {key: "Ctrl-f", run: cursorCharRight, shift: selectCharRight},

  {key: "Ctrl-p", run: cursorLineUp, shift: selectLineUp},
  {key: "Ctrl-n", run: cursorLineDown, shift: selectLineDown},

  {key: "Ctrl-a", run: cursorLineStart, shift: selectLineStart},
  {key: "Ctrl-e", run: cursorLineEnd, shift: selectLineEnd},

  {key: "Ctrl-d", run: deleteCharForward},
  {key: "Ctrl-h", run: deleteCharBackward},
  {key: "Ctrl-k", run: deleteToLineEnd},
  {key: "Ctrl-Alt-h", run: deleteGroupBackward},

  {key: "Ctrl-o", run: splitLine},
  {key: "Ctrl-t", run: transposeChars},

  {key: "Ctrl-v", run: cursorPageDown},
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
///  - Enter and Shift-Enter: [`insertNewlineAndIndent`](#commands.insertNewlineAndIndent)
///  - Ctrl-a (Cmd-a on macOS): [`selectAll`](#commands.selectAll)
///  - Backspace: [`deleteCharBackward`](#commands.deleteCharBackward)
///  - Delete: [`deleteCharForward`](#commands.deleteCharForward)
///  - Ctrl-Backspace (Alt-Backspace on macOS): [`deleteGroupBackward`](#commands.deleteGroupBackward)
///  - Ctrl-Delete (Alt-Delete on macOS): [`deleteGroupForward`](#commands.deleteGroupForward)
///  - Cmd-Backspace (macOS): [`deleteLineBoundaryBackward`](#commands.deleteLineBoundaryBackward).
///  - Cmd-Delete (macOS): [`deleteLineBoundaryForward`](#commands.deleteLineBoundaryForward).
export const standardKeymap: readonly KeyBinding[] = ([
  {key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true},
  {key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: cursorGroupLeft, shift: selectGroupLeft, preventDefault: true},
  {mac: "Cmd-ArrowLeft", run: cursorLineBoundaryLeft, shift: selectLineBoundaryLeft, preventDefault: true},

  {key: "ArrowRight", run: cursorCharRight, shift: selectCharRight, preventDefault: true},
  {key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: cursorGroupRight, shift: selectGroupRight, preventDefault: true},
  {mac: "Cmd-ArrowRight", run: cursorLineBoundaryRight, shift: selectLineBoundaryRight, preventDefault: true},

  {key: "ArrowUp", run: cursorLineUp, shift: selectLineUp, preventDefault: true},
  {mac: "Cmd-ArrowUp", run: cursorDocStart, shift: selectDocStart},
  {mac: "Ctrl-ArrowUp", run: cursorPageUp, shift: selectPageUp},

  {key: "ArrowDown", run: cursorLineDown, shift: selectLineDown, preventDefault: true},
  {mac: "Cmd-ArrowDown", run: cursorDocEnd, shift: selectDocEnd},
  {mac: "Ctrl-ArrowDown", run: cursorPageDown, shift: selectPageDown},

  {key: "PageUp", run: cursorPageUp, shift: selectPageUp},
  {key: "PageDown", run: cursorPageDown, shift: selectPageDown},

  {key: "Home", run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward, preventDefault: true},
  {key: "Mod-Home", run: cursorDocStart, shift: selectDocStart},

  {key: "End", run: cursorLineBoundaryForward, shift: selectLineBoundaryForward, preventDefault: true},
  {key: "Mod-End", run: cursorDocEnd, shift: selectDocEnd},

  {key: "Enter", run: insertNewlineAndIndent, shift: insertNewlineAndIndent},

  {key: "Mod-a", run: selectAll},

  {key: "Backspace", run: deleteCharBackward, shift: deleteCharBackward},
  {key: "Delete", run: deleteCharForward},
  {key: "Mod-Backspace", mac: "Alt-Backspace", run: deleteGroupBackward},
  {key: "Mod-Delete", mac: "Alt-Delete", run: deleteGroupForward},
  {mac: "Mod-Backspace", run: deleteLineBoundaryBackward},
  {mac: "Mod-Delete", run: deleteLineBoundaryForward}
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
/// - Ctrl-Enter (Cmd-Enter on macOS): [`insertBlankLine`](#commands.insertBlankLine)
/// - Alt-l (Ctrl-l on macOS): [`selectLine`](#commands.selectLine)
/// - Ctrl-i (Cmd-i on macOS): [`selectParentSyntax`](#commands.selectParentSyntax)
/// - Ctrl-[ (Cmd-[ on macOS): [`indentLess`](#commands.indentLess)
/// - Ctrl-] (Cmd-] on macOS): [`indentMore`](#commands.indentMore)
/// - Ctrl-Alt-\\ (Cmd-Alt-\\ on macOS): [`indentSelection`](#commands.indentSelection)
/// - Shift-Ctrl-k (Shift-Cmd-k on macOS): [`deleteLine`](#commands.deleteLine)
/// - Shift-Ctrl-\\ (Shift-Cmd-\\ on macOS): [`cursorMatchingBracket`](#commands.cursorMatchingBracket)
/// - Ctrl-/ (Cmd-/ on macOS): [`toggleComment`](#commands.toggleComment).
/// - Shift-Alt-a: [`toggleBlockComment`](#commands.toggleBlockComment).
/// - Ctrl-m (Alt-Shift-m on macOS): [`toggleTabFocusMode`](#commands.toggleTabFocusMode).
export const defaultKeymap: readonly KeyBinding[] = ([
  {key: "Alt-ArrowLeft", mac: "Ctrl-ArrowLeft", run: cursorSyntaxLeft, shift: selectSyntaxLeft},
  {key: "Alt-ArrowRight", mac: "Ctrl-ArrowRight", run: cursorSyntaxRight, shift: selectSyntaxRight},

  {key: "Alt-ArrowUp", run: moveLineUp},
  {key: "Shift-Alt-ArrowUp", run: copyLineUp},

  {key: "Alt-ArrowDown", run: moveLineDown},
  {key: "Shift-Alt-ArrowDown", run: copyLineDown},

  {key: "Escape", run: simplifySelection},
  {key: "Mod-Enter", run: insertBlankLine},

  {key: "Alt-l", mac: "Ctrl-l", run: selectLine},
  {key: "Mod-i", run: selectParentSyntax, preventDefault: true},

  {key: "Mod-[", run: indentLess},
  {key: "Mod-]", run: indentMore},
  {key: "Mod-Alt-\\", run: indentSelection},

  {key: "Shift-Mod-k", run: deleteLine},

  {key: "Shift-Mod-\\", run: cursorMatchingBracket},

  {key: "Mod-/", run: toggleComment},
  {key: "Alt-A", run: toggleBlockComment},

  {key: "Ctrl-m", mac: "Shift-Alt-m", run: toggleTabFocusMode},
] as readonly KeyBinding[]).concat(standardKeymap)

/// A binding that binds Tab to [`indentMore`](#commands.indentMore) and
/// Shift-Tab to [`indentLess`](#commands.indentLess).
/// Please see the [Tab example](../../examples/tab/) before using
/// this.
export const indentWithTab: KeyBinding =
  {key: "Tab", run: indentMore, shift: indentLess}
