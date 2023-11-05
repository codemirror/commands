import ist from "ist"

import {EditorState, EditorSelection, Transaction,
        StateEffect, StateEffectType, StateField, ChangeDesc} from "@codemirror/state"
import {isolateHistory, history, redo, redoDepth, redoSelection, undo, undoDepth,
        undoSelection, invertedEffects, historyField} from "@codemirror/commands"

function mkState(config?: any, doc?: string) {
  return EditorState.create({
    extensions: [history(config), EditorState.allowMultipleSelections.of(true)],
    doc
  })
}

function type(state: EditorState, text: string, at = state.doc.length) {
  return state.update({changes: {from: at, insert: text}}).state
}
function timedType(state: EditorState, text: string, atTime: number) {
  return state.update({changes: {from: state.doc.length, insert: text},
                   annotations: Transaction.time.of(atTime)}).state
}
function receive(state: EditorState, text: string, from: number, to = from) {
  return state.update({changes: {from, to, insert: text},
                   annotations: Transaction.addToHistory.of(false)}).state
}
function command(state: EditorState, cmd: any, success: boolean = true) {
  ist(cmd({state, dispatch(tr: Transaction) { state = tr.state }}), success)
  return state
}

describe("history", () => {
  it("allows to undo a change", () => {
    let state = mkState()
    state = type(state, "newtext")
    state = command(state, undo)
    ist(state.doc.toString(), "")
  })

  it("allows to undo nearby changes in one change", () => {
    let state = mkState()
    state = type(state, "new")
    state = type(state, "text")
    state = command(state, undo)
    ist(state.doc.toString(), "")
  })

  it("allows to redo a change", () => {
    let state = mkState()
    state = type(state, "newtext")
    state = command(state, undo)
    state = command(state, redo)
    ist(state.doc.toString(), "newtext")
  })

  it("allows to redo nearby changes in one change", () => {
    let state = mkState()
    state = type(state, "new")
    state = type(state, "text")
    state = command(state, undo)
    state = command(state, redo)
    ist(state.doc.toString(), "newtext")
  })

  it("puts the cursor after the change on redo", () => {
    let state = mkState({}, "one\n\ntwo")
    state = state.update({changes: {from: 3, insert: "!"}, selection: {anchor: 4}}).state
    state = state.update({selection: {anchor: state.doc.length}}).state
    state = command(state, undo)
    state = command(state, redo)
    ist(state.selection.main.head, 4)
  })

  it("tracks multiple levels of history", () => {
    let state = mkState({}, "one")
    state = type(state, "new")
    state = type(state, "text")
    state = type(state, "some", 0)
    ist(state.doc.toString(), "someonenewtext")
    state = command(state, undo)
    ist(state.doc.toString(), "onenewtext")
    state = command(state, undo)
    ist(state.doc.toString(), "one")
    state = command(state, redo)
    ist(state.doc.toString(), "onenewtext")
    state = command(state, redo)
    ist(state.doc.toString(), "someonenewtext")
    state = command(state, undo)
    ist(state.doc.toString(), "onenewtext")
  })

  it("starts a new event when newGroupDelay elapses", () => {
    let state = mkState({newGroupDelay: 1000})
    state = timedType(state, "a", 1000)
    state = timedType(state, "b", 1600)
    ist(undoDepth(state), 1)
    state = timedType(state, "c", 2700)
    ist(undoDepth(state), 2)
    state = command(state, undo)
    state = timedType(state, "d", 2800)
    ist(undoDepth(state), 2)
  })

  it("supports a custom join predicate", () => {
    let state = mkState({joinToEvent: (tr: Transaction, adj: boolean) => {
      if (!adj) return false
      let space = false
      if (adj) tr.changes.iterChanges((fA, tA, fB, tB, text) => {
        if (text.length && text.sliceString(0, 1) == " ") space = true
      })
      return !space
    }})
    for (let ch of "ab cd") state = type(state, ch)
    ist(state.sliceDoc(), "ab cd")
    state = command(state, undo)
    ist(state.sliceDoc(), "ab")
    state = command(state, undo)
    ist(state.sliceDoc(), "")
  })

  it("allows changes that aren't part of the history", () => {
    let state = mkState()
    state = type(state, "hello")
    state = receive(state, "oops", 0)
    state = receive(state, "!", 9)
    state = command(state, undo)
    ist(state.doc.toString(), "oops!")
  })

  it("doesn't get confused by an undo not adding any redo item", () => {
    let state = mkState({}, "ab")
    state = type(state, "cd", 1)
    state = receive(state, "123", 0, 4)
    state = command(state, undo, false)
    command(state, redo, false)
  })

  it("accurately maps changes through each other", () => {
    let state = mkState({}, "123")
    state = state.update({
      changes: [{from: 0, to: 1, insert: "ab"}, {from: 1, to: 2, insert: "cd"}, {from: 2, to: 3, insert: "ef"}]
    }).state
    state = receive(state, "!!!!!!!!", 2, 2)
    state = command(state, undo)
    state = command(state, redo)
    ist(state.doc.toString(), "ab!!!!!!!!cdef")
  })

  it("can handle complex editing sequences", () => {
    let state = mkState()
    state = type(state, "hello")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = type(state, "!")
    state = receive(state, "....", 0)
    state = type(state, "\n\n", 2)
    ist(state.doc.toString(), "..\n\n..hello!")
    state = receive(state, "\n\n", 1)
    state = command(state, undo)
    state = command(state, undo)
    ist(state.doc.toString(), ".\n\n...hello")
    state = command(state, undo)
    ist(state.doc.toString(), ".\n\n...")
  })

  it("supports overlapping edits", () => {
    let state = mkState()
    state = type(state, "hello")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = state.update({changes: {from: 0, to: 5}}).state
    ist(state.doc.toString(), "")
    state = command(state, undo)
    ist(state.doc.toString(), "hello")
    state = command(state, undo)
    ist(state.doc.toString(), "")
  })

  it("supports overlapping edits that aren't collapsed", () => {
    let state = mkState()
    state = receive(state, "h", 0)
    state = type(state, "ello")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = state.update({changes: {from: 0, to: 5}}).state
    ist(state.doc.toString(), "")
    state = command(state, undo)
    ist(state.doc.toString(), "hello")
    state = command(state, undo)
    ist(state.doc.toString(), "h")
  })

  it("supports overlapping unsynced deletes", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = type(state, "hello")
    state = state.update({changes: {from: 0, to: 7}, annotations: Transaction.addToHistory.of(false)}).state
    ist(state.doc.toString(), "")
    state = command(state, undo, false)
    ist(state.doc.toString(), "")
  })

  it("can go back and forth through history multiple times", () => {
    let state = mkState()
    state = type(state, "one")
    state = type(state, " two")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = type(state, " three")
    state = type(state, "zero ", 0)
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = type(state, "\n\n", 0)
    state = type(state, "top", 0)
    for (let i = 0; i < 6; i++) {
      let re = i % 2
      for (let j = 0; j < 4; j++) state = command(state, re ? redo : undo)
      ist(state.doc.toString(), re ? "top\n\nzero one two three" : "")
    }
  })

  it("supports non-tracked changes next to tracked changes", () => {
    let state = mkState()
    state = type(state, "o")
    state = type(state, "\n\n", 0)
    state = receive(state, "zzz", 3)
    state = command(state, undo)
    ist(state.doc.toString(), "zzz")
  })

  it("can go back and forth through history when preserving items", () => {
    let state = mkState()
    state = type(state, "one")
    state = type(state, " two")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = receive(state, "xxx", state.doc.length)
    state = type(state, " three")
    state = type(state, "zero ", 0)
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = type(state, "\n\n", 0)
    state = type(state, "top", 0)
    state = receive(state, "yyy", 0)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) state = command(state, undo)
      ist(state.doc.toString(), "yyyxxx")
      for (let j = 0; j < 4; j++) state = command(state, redo)
      ist(state.doc.toString(), "yyytop\n\nzero one twoxxx three")
    }
  })

  it("restores selection on undo", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = state.update({selection: {anchor: 0, head: 2}}).state
    const selection = state.selection
    state = state.update(state.replaceSelection("hello")).state
    const selection2 = state.selection
    state = command(state, undo)
    ist(state.selection.eq(selection))
    state = command(state, redo)
    ist(state.selection.eq(selection2))
  })

  it("restores the selection before the first change in an item (#46)", () => {
    let state = mkState()
    state = state.update({changes: {from: 0, insert: "a"}, selection: {anchor: 1}}).state
    state = state.update({changes: {from: 1, insert: "b"}, selection: {anchor: 2}}).state
    state = command(state, undo)
    ist(state.doc.toString(), "")
    ist(state.selection.main.anchor, 0)
  })

  it("doesn't merge document changes if there's a selection change in between", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.update({selection: {anchor: 0, head: 2}}).state
    state = state.update(state.replaceSelection("hello")).state
    ist(undoDepth(state), 2)
  })

  it("rebases selection on undo", () => {
    let state = mkState()
    state = type(state, "hi")
    state = state.update({annotations: isolateHistory.of("before")}).state
    state = state.update({selection: {anchor: 0, head: 2}}).state
    state = type(state, "hello", 0)
    state = receive(state, "---", 0)
    state = command(state, undo)
    ist(state.selection.ranges[0].head, 5)
  })

  it("supports querying for the undo and redo depth", () => {
    let state = mkState()
    state = type(state, "a")
    ist(undoDepth(state), 1)
    ist(redoDepth(state), 0)
    state = receive(state, "b", 0)
    ist(undoDepth(state), 1)
    ist(redoDepth(state), 0)
    state = command(state, undo)
    ist(undoDepth(state), 0)
    ist(redoDepth(state), 1)
    state = command(state, redo)
    ist(undoDepth(state), 1)
    ist(redoDepth(state), 0)
  })

  it("all functions gracefully handle EditorStates without history", () => {
    let state = EditorState.create()
    ist(undoDepth(state), 0)
    ist(redoDepth(state), 0)
    command(state, undo, false)
    command(state, redo, false)
  })

  it("truncates history", () => {
    let state = mkState({minDepth: 10})
    for (let i = 0; i < 40; ++i) {
      state = type(state, "a")
      state = state.update({annotations: isolateHistory.of("before")}).state
    }
    ist(undoDepth(state) < 40)
  })

  it("doesn't undo selection-only transactions", () => {
    let state = mkState(undefined, "abc")
    ist(state.selection.main.head, 0)
    state = state.update({selection: {anchor: 2}}).state
    state = command(state, undo, false)
    ist(state.selection.main.head, 2)
  })

  it("isolates transactions when asked to", () => {
    let state = mkState()
    state = state.update({changes: {from: 0, insert: "a"}, annotations: isolateHistory.of("after")}).state
    state = state.update({changes: {from: 1, insert: "a"}}).state
    state = state.update({changes: {from: 2, insert: "c"}, annotations: isolateHistory.of("after")}).state
    state = state.update({changes: {from: 3, insert: "d"}}).state
    state = state.update({changes: {from: 4, insert: "e"}, annotations: isolateHistory.of("full")}).state
    state = state.update({changes: {from: 5, insert: "f"}}).state
    ist(undoDepth(state), 5)
  })

  it("can group events around a non-history transaction", () => {
    let state = mkState()
    state = state.update({changes: {from: 0, insert: "a"}}).state
    state = state.update({changes: {from: 1, insert: "b"}, annotations: Transaction.addToHistory.of(false)}).state
    state = state.update({changes: {from: 1, insert: "c"}}).state
    state = command(state, undo)
    ist(state.doc.toString(), "b")
  })

  it("properly maps selections through non-history changes", () => {
    let state = mkState({}, "abc")
    state = state.update({selection: EditorSelection.create([EditorSelection.cursor(0),
                                                             EditorSelection.cursor(1),
                                                             EditorSelection.cursor(2)])}).state
    state = state.update({changes: {from: 0, to: 3, insert: "d"}}).state
    state = state.update({changes: [{from: 0, insert: "x"}, {from: 1, insert: "y"}],
                          annotations: Transaction.addToHistory.of(false)}).state
    state = command(state, undo)
    ist(state.doc.toString(), "xabcy")
    ist(state.selection.ranges.map(r => r.from).join(","), "0,2,3")
  })

  it("restores selection on redo", () => {
    let state = mkState({}, "a\nb\nc\n")
    state = state.update({selection: EditorSelection.create([1, 3, 5].map(n => EditorSelection.cursor(n)))}).state
    state = state.update(state.replaceSelection("-")).state
    state = state.update({selection:  {anchor: 0}}).state
    state = command(state, undo)
    state = state.update({selection:  {anchor: 0}}).state
    state = command(state, redo)
    ist(state.selection.ranges.map(r => r.head).join(","), "2,5,8")
  })

  describe("undoSelection", () => {
    it("allows to undo a change", () => {
      let state = mkState()
      state = type(state, "newtext")
      state = command(state, undoSelection)
      ist(state.doc.toString(), "")
    })

    it("allows to undo selection-only transactions", () => {
      let state = mkState(undefined, "abc")
      ist(state.selection.main.head, 0)
      state = state.update({selection: {anchor: 2}}).state
      state = command(state, undoSelection)
      ist(state.selection.main.head, 0)
    })

    it("merges selection-only transactions from keyboard", () => {
      let state = mkState(undefined, "abc")
      ist(state.selection.main.head, 0)
      state = state.update({selection: {anchor: 2}, userEvent: "select"}).state
      state = state.update({selection: {anchor: 3}, userEvent: "select"}).state
      state = state.update({selection: {anchor: 1}, userEvent: "select"}).state
      state = command(state, undoSelection)
      ist(state.selection.main.head, 0)
    })

    it("doesn't merge selection-only transactions from other sources", () => {
      let state = mkState(undefined, "abc")
      ist(state.selection.main.head, 0)
      state = state.update({selection: {anchor: 2}}).state
      state = state.update({selection: {anchor: 3}}).state
      state = state.update({selection: {anchor: 1}}).state
      state = command(state, undoSelection)
      ist(state.selection.main.head, 3)
      state = command(state, undoSelection)
      ist(state.selection.main.head, 2)
      state = command(state, undoSelection)
      ist(state.selection.main.head, 0)
    })

    it("doesn't merge selection-only transactions if they change the number of selections", () => {
      let state = mkState(undefined, "abc")
      ist(state.selection.main.head, 0)
      state = state.update({selection: {anchor: 2}, userEvent: "select"}).state
      state = state.update({selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
                            userEvent: "select"}).state
      state = state.update({selection: {anchor: 1}, userEvent: "select"}).state
      state = command(state, undoSelection)
      ist(state.selection.ranges.length, 2)
      state = command(state, undoSelection)
      ist(state.selection.main.head, 0)
    })

    it("doesn't merge selection-only transactions if a selection changes empty state", () => {
      let state = mkState(undefined, "abc")
      ist(state.selection.main.head, 0)
      state = state.update({selection: {anchor: 2}, userEvent: "select"}).state
      state = state.update({selection: {anchor: 2, head: 3}, userEvent: "select"}).state
      state = state.update({selection: {anchor: 1}, userEvent: "select"}).state
      state = command(state, undoSelection)
      ist(state.selection.main.anchor, 2)
      ist(state.selection.main.head, 3)
      state = command(state, undoSelection)
      ist(state.selection.main.head, 0)
    })

    it("allows to redo a change", () => {
      let state = mkState()
      state = type(state, "newtext")
      state = command(state, undoSelection)
      state = command(state, redoSelection)
      ist(state.doc.toString(), "newtext")
    })

    it("allows to redo selection-only transactions", () => {
      let state = mkState(undefined, "abc")
      ist(state.selection.main.head, 0)
      state = state.update({selection: {anchor: 2}}).state
      state = command(state, undoSelection)
      state = command(state, redoSelection)
      ist(state.selection.main.head, 2)
    })

    it("only changes selection", () => {
      let state = mkState()
      state = type(state, "hi")
      state = state.update({annotations: isolateHistory.of("before")}).state
      const selection = state.selection
      state = state.update({selection: {anchor: 0, head: 2}}).state
      const selection2 = state.selection
      state = command(state, undoSelection)
      ist(state.selection.eq(selection))
      ist(state.doc.toString(), "hi")
      state = command(state, redoSelection)
      ist(state.selection.eq(selection2))
      state = state.update(state.replaceSelection("hello")).state
      const selection3 = state.selection
      state = command(state, undoSelection)
      ist(state.selection.eq(selection2))
      state = command(state, redo)
      ist(state.selection.eq(selection3))
    })

    it("can undo a selection through remote changes", () => {
      let state = mkState()
      state = type(state, "hello")
      const selection = state.selection
      state = state.update({selection: {anchor: 0, head: 2}}).state
      state = receive(state, "oops", 0)
      state = receive(state, "!", 9)
      ist(state.selection.eq(EditorSelection.single(4, 6)))
      state = command(state, undoSelection)
      ist(state.doc.toString(), "oopshello!")
      ist(state.selection.eq(selection))
    })

    it("preserves text inserted inside a change", () => {
      let state = mkState()
      state = type(state, "1234")
      state = state.update({changes: {from: 2, insert: "x"}, annotations: Transaction.addToHistory.of(false)}).state
      state = command(state, undo)
      ist(state.doc.toString(), "x")
    })
  })

  describe("effects", () => {
    it("includes inverted effects in the history", () => {
      let set = StateEffect.define<number>()
      let field = StateField.define({
        create: () => 0,
        update(val, tr) {
          for (let effect of tr.effects) if (effect.is(set)) val = effect.value
          return val
        }
      })
      let invert = invertedEffects.of(tr => {
        for (let e of tr.effects) if (e.is(set)) return [set.of(tr.startState.field(field))]
        return []
      })
      let state = EditorState.create({extensions: [history(), field, invert]})
      state = state.update({effects: set.of(10), annotations: isolateHistory.of("before")}).state
      state = state.update({effects: set.of(20), annotations: isolateHistory.of("before")}).state
      ist(state.field(field), 20)
      state = command(state, undo)
      ist(state.field(field), 10)
      state = command(state, undo)
      ist(state.field(field), 0)
      state = command(state, redo)
      ist(state.field(field), 10)
      state = command(state, redo)
      ist(state.field(field), 20)
      state = command(state, undo)
      ist(state.field(field), 10)
      state = command(state, redo)
      ist(state.field(field), 20)
    })

    class Comment {
      constructor(readonly from: number,
                  readonly to: number,
                  readonly text: string) {}

      eq(other: Comment) { return this.from == other.from && this.to == other.to && this.text == other.text }
    }
    function mapComment(comment: Comment, mapping: ChangeDesc) {
      let from = mapping.mapPos(comment.from, 1), to = mapping.mapPos(comment.to, -1)
      return from >= to ? undefined : new Comment(from, to, comment.text)
    }
    let addComment: StateEffectType<Comment> = StateEffect.define<Comment>({map: mapComment})
    let rmComment: StateEffectType<Comment> = StateEffect.define<Comment>({map: mapComment})
    let comments = StateField.define<Comment[]>({
      create: () => [],
      update(value, tr) {
        value = value.map(c => mapComment(c, tr.changes)).filter(x => x) as any
        for (let effect of tr.effects) {
          if (effect.is(addComment)) value = value.concat(effect.value)
          else if (effect.is(rmComment)) value = value.filter(c => !c.eq(effect.value))
        }
        return value.sort((a, b) => a.from - b.from)
      }
    })
    let invertComments = invertedEffects.of(tr => {
      let effects = []
      for (let effect of tr.effects) {
        if (effect.is(addComment) || effect.is(rmComment)) {
          let src = mapComment(effect.value, tr.changes.invertedDesc)
          if (src) effects.push((effect.is(addComment) ? rmComment : addComment).of(src))
        }
      }
      for (let comment of tr.startState.field(comments)) {
        if (!mapComment(comment, tr.changes)) effects.push(addComment.of(comment))
      }
      return effects
    })

    function commentStr(state: EditorState) { return state.field(comments).map(c => c.text + "@" + c.from).join(",") }

    it("can map effects", () => {
      let state = EditorState.create({extensions: [history(), comments, invertComments],
                                      doc: "one two foo"})
      state = state.update({effects: addComment.of(new Comment(0, 3, "c1")),
                            annotations: isolateHistory.of("full")}).state
      ist(commentStr(state), "c1@0")
      state = state.update({changes: {from: 3, to: 4, insert: "---"},
                            annotations: isolateHistory.of("full"),
                            effects: addComment.of(new Comment(6, 9, "c2"))}).state
      ist(commentStr(state), "c1@0,c2@6")
      state = state.update({changes: {from: 0, insert: "---"}, annotations: Transaction.addToHistory.of(false)}).state
      ist(commentStr(state), "c1@3,c2@9")
      state = command(state, undo)
      ist(state.doc.toString(), "---one two foo")
      ist(commentStr(state), "c1@3")
      state = command(state, undo)
      ist(commentStr(state), "")
      state = command(state, redo)
      ist(commentStr(state), "c1@3")
      state = command(state, redo)
      ist(commentStr(state), "c1@3,c2@9")
      ist(state.doc.toString(), "---one---two foo")
      state = command(state, undo).update({changes: {from: 10, to: 11, insert: "---"},
                                           annotations: Transaction.addToHistory.of(false)}).state
      state = state.update({effects: addComment.of(new Comment(13, 16, "c3")),
                            annotations: isolateHistory.of("full")}).state
      ist(commentStr(state), "c1@3,c3@13")
      state = command(state, undo)
      ist(state.doc.toString(), "---one two---foo")
      ist(commentStr(state), "c1@3")
      state = command(state, redo)
      ist(commentStr(state), "c1@3,c3@13")
    })

    it("can restore comments lost through deletion", () => {
      let state = EditorState.create({extensions: [history(), comments, invertComments],
                                      doc: "123456"})
      state = state.update({effects: addComment.of(new Comment(3, 5, "c1")),
                        annotations: isolateHistory.of("full")}).state
      state = state.update({changes: {from: 2, to: 6}}).state
      ist(commentStr(state), "")
      state = command(state, undo)
      ist(commentStr(state), "c1@3")
    })
  })

  describe("JSON", () => {
    it("survives serialization", () => {
      let state = EditorState.create({doc: "abcd", extensions: history()})
      state = state.update({changes: {from: 3, to: 4}}).state
      state = state.update({changes: {from: 0, insert: "d"}}).state
      state = command(state, undo)
      let jsonConf = {history: historyField}
      let json = JSON.stringify(state.toJSON(jsonConf))
      state = EditorState.fromJSON(JSON.parse(json), {extensions: history()}, jsonConf)
      ist(state.doc.toString(), "abc")
      state = command(state, redo)
      ist(state.doc.toString(), "dabc")
      state = command(command(state, undo), undo)
      ist(state.doc.toString(), "abcd")
    })
  })
})
