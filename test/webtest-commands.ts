import {EditorView, Command, Decoration, WidgetType, keymap} from "@codemirror/view"
import {Extension, EditorState} from "@codemirror/state"
import {cursorSubwordForward, cursorSubwordBackward, cursorLineDown, cursorLineUp, defaultKeymap, cursorLineBoundaryRight, selectLineDown, selectLineUp, cursorLineBoundaryLeft} from "@codemirror/commands"
import ist from "ist"
import {mkState, stateStr} from "./state.js"

const dashWordChar = EditorState.languageData.of(() => [{wordChars: "-"}])

function testCmd(before: string, after: string, command: Command, extensions?: Extension): void
function testCmd(before: string, steps: [Command, string][], extensions?: Extension): void
function testCmd(before: string, afterOrSteps: string | [Command, string][], commandOrExt?: Command | Extension, extensions?: Extension) {
  let steps: [Command, string][]
  let exts: Extension
  if (typeof afterOrSteps === "string") {
    steps = [[commandOrExt as Command, afterOrSteps]]
    exts = extensions || []
  } else {
    steps = afterOrSteps
    exts = (commandOrExt as Extension) || []
  }
  let state = mkState(before, exts)
  let view = new EditorView({
    state,
    parent: document.querySelector("#workspace")! as HTMLElement
  })
  try {
    for (let [cmd, expected] of steps) {
      cmd(view)
      ist(stateStr(view.state), expected)
    }
  } finally {
    view.destroy()
  }
}

describe("commands", () => {
  describe("cursorSubwordForward", () => {
    it("stops at first camelcase boundary", () =>
      testCmd("|CamelCaseWord", "Camel|CaseWord", cursorSubwordForward))

    it("stops at inner camelcase boundary", () =>
      testCmd("Camel|CaseWord", "CamelCase|Word", cursorSubwordForward))

    it("stops at last camelcase boundary", () =>
      testCmd("CamelCase|Word", "CamelCaseWord|", cursorSubwordForward))

    it("treats ranges of capitals as a single word", () =>
      testCmd("Eat|CSSToken", "EatCSS|Token", cursorSubwordForward))

    it("stops at the end of word", () =>
      testCmd("o|kay.", "okay|.", cursorSubwordForward))

    it("stops before underscores", () =>
      testCmd("|snake_case", "snake|_case", cursorSubwordForward))

    it("stops after underscores", () =>
      testCmd("snake|_case", "snake_|case", cursorSubwordForward))

    it("stops before dashes", () =>
      testCmd("|kebab-case", "kebab|-case", cursorSubwordForward, dashWordChar))

    it("stops after dashes", () =>
      testCmd("kebab|-case", "kebab-|case", cursorSubwordForward, dashWordChar))

    it("stops on dashes at end of word", () =>
      testCmd("one|--..", "one--|..", cursorSubwordForward, dashWordChar))

    if (typeof Intl != "undefined" && (Intl as any).Segmenter) {
      it("stops on CJK word boundaries", () => {
        testCmd("|马在路上小跑着。", "马|在路上小跑着。", cursorSubwordForward)
        testCmd("马|在路上小跑着。", "马在|路上小跑着。", cursorSubwordForward)
        testCmd("马在|路上小跑着。", "马在路上|小跑着。", cursorSubwordForward)
      })
    }
  })

  describe("cursorSubwordBackward", () => {
    it("stops at camelcase boundary", () =>
      testCmd("CamelCaseWord|", "CamelCase|Word", cursorSubwordBackward))

    it("stops at last camelcase boundary", () =>
      testCmd("Camel|CaseWord", "|CamelCaseWord", cursorSubwordBackward))

    it("treats ranges of capitals as a single word", () =>
      testCmd("EatCSS|Token", "Eat|CSSToken", cursorSubwordBackward))

    it("stops at the end of word", () =>
      testCmd(".o|kay", ".|okay", cursorSubwordBackward))

    it("stops before underscores", () =>
      testCmd("snake_case|", "snake_|case", cursorSubwordBackward))

    it("stops after underscores", () =>
      testCmd("snake_|case", "snake|_case", cursorSubwordBackward))

    it("stops before dashes", () =>
      testCmd("kebab-case|", "kebab-|case", cursorSubwordBackward, dashWordChar))

    it("stops after dashes", () =>
      testCmd("kebab--|case", "kebab|--case", cursorSubwordBackward, dashWordChar))

    it("stops on dashes at end of word", () =>
      testCmd("..--one|", "..--|one", cursorSubwordBackward, dashWordChar))

    if (typeof Intl != "undefined" && (Intl as any).Segmenter) {
      it("stops on CJK word boundaries", () => {
        testCmd("马在路上小跑着|。", "马在路上小跑|着。", cursorSubwordBackward)
        testCmd("马在路上小跑|着。", "马在路上|小跑着。", cursorSubwordBackward)
        testCmd("马在路上|小跑着。", "马在|路上小跑着。", cursorSubwordBackward)
      })
    }
  })

  let w = new class extends WidgetType {
    toDOM() { let d = document.createElement("div"); d.style.cssText = "color: blue; height: 4em"; return d }
  }

  describe("cursorLineDown", () => {
    it("can move to the next line", () => {
      testCmd("on|e\ntwo", "one\ntw|o", cursorLineDown)
    })

    it("can move to a shorter line", () => {
      testCmd("on|e\nt", "one\nt|", cursorLineDown)
    })

    it("goes to the end on last line", () => {
      testCmd("on|e", "one|", cursorLineDown)
    })

    it("keeps a colum pos across a shorter line", () => {
      testCmd("on|e\nt\nthree", "one\nt\nth|ree", v => { cursorLineDown(v); cursorLineDown(v); return true })
    })

    it("can move in a wrapped line", () => {
      testCmd("da|ndelion dandelion dandelion",
              "dandelion da|ndelion dandelion",
              cursorLineDown,
              [EditorView.theme({"&": {maxWidth: "13ch"}}), EditorView.lineWrapping])
    })

    it("can move in a wrapped line with large line height", () => {
      testCmd("da|ndelion dandelion dandelion",
              "dandelion da|ndelion dandelion",
              cursorLineDown,
              [EditorView.theme({"&": {maxWidth: "13ch"}, ".cm-line": {lineHeight: "3"}}), EditorView.lineWrapping])
    })

    it("can extend in a wrapped line from fragment start", () => {
      testCmd("2 dandelion dandelion two dandelion !", [
        [cursorLineBoundaryLeft, "|2 dandelion dandelion two dandelion !"],
        [selectLineDown, "<2 dandelion >dandelion two dandelion !"],
        [selectLineDown, "<2 dandelion dandelion >two dandelion !"],
      ], [keymap.of(defaultKeymap), EditorView.theme({"&": {maxWidth: "13ch"}}), EditorView.lineWrapping])
    })

    it("can extend down in a wrapped line from fragment end", () => {
      testCmd("2 dandelion dandelion two dandelion !", [
        [cursorLineBoundaryRight, "2 dandelion |dandelion two dandelion !"],
        [selectLineDown, "2 dandelion <dandelion >two dandelion !"],
        [selectLineDown, "2 dandelion <dandelion two >dandelion !"],
      ], [keymap.of(defaultKeymap), EditorView.theme({"&": {maxWidth: "13ch"}}), EditorView.lineWrapping])
    })

    it("can extend up in a wrapped line from fragment start", () => {
      testCmd("2 dandelion dandelion two dandelion !", [
        [cursorLineDown, "2 dandelion |dandelion two dandelion !"],
        [cursorLineDown, "2 dandelion dandelion |two dandelion !"],
        [selectLineUp, "2 dandelion <dandelion >two dandelion !"],
        [selectLineUp, "<2 dandelion dandelion >two dandelion !"],
        [selectLineDown, "2 dandelion <dandelion >two dandelion !"],
        [selectLineDown, "2 dandelion dandelion |two dandelion !"],
        [selectLineUp, "2 dandelion <dandelion >two dandelion !"],
      ], [keymap.of(defaultKeymap), EditorView.theme({"&": {maxWidth: "13ch"}}), EditorView.lineWrapping])
    })

    it("isn't affected by folded lines", () => {
      testCmd("on|e two\nthree four\nfive six\nseven eight",
              "one two\nthree four\nfive six\nse|ven eight",
              cursorLineDown,
              EditorView.decorations.of(Decoration.set(Decoration.replace({}).range(5, 26))))
    })

    it("skips block widgets", () => {
      testCmd("on|e\ntwo\nthree\nfour",
              "one\ntwo\nthree\nfo|ur",
              cursorLineDown,
              EditorView.decorations.of(Decoration.set(Decoration.replace({widget: w, block: true}).range(4, 13))))
    })

    it("skips multiple block widgets", () => {
      testCmd("on|e\ntwo\nthree\nfour",
              "one\ntwo\nthree\nfo|ur",
              cursorLineDown,
              EditorView.decorations.of(Decoration.set([
                Decoration.replace({widget: w, block: true}).range(4, 7),
                Decoration.replace({widget: w, block: true}).range(8, 13)
              ])))
    })

    it("skips inline widgets on their own line", () => {
      let widget = new class extends WidgetType {
        toDOM() {
          let s = document.createElement("span")
          s.textContent = "x".repeat(100)
          return s
        }
      }
      testCmd("a|aaaaaaaaa\nbc", "aaaaaaaaaa\nb|c", cursorLineDown, [
                EditorView.decorations.of(Decoration.set([
                  Decoration.widget({widget, side: 1}).range(10)
                ])),
                EditorView.lineWrapping
      ])
    })

    it("can escape lines with padding", () => {
      let attributes = {style: "padding-bottom: 30px 0"}
      testCmd("a\n|b\nc", "a\nb\n|c",
              cursorLineDown,
              EditorView.decorations.of(Decoration.set(Decoration.line({attributes}).range(2))))
    })
  })

  describe("selectLineDown", () => {
    it("goes to the end on last line", () => {
      testCmd("on|e", "on<e>", selectLineDown)
    })
  })

  describe("selectLineUp", () => {
    it("goes to the start on first line", () => {
      testCmd("on|e", "<on>e", selectLineUp)
    })
  })

  describe("cursorLineUp", () => {
    it("can move to the previous line", () => {
      testCmd("one\ntwo|", "one|\ntwo", cursorLineUp)
    })

    it("can move to a shorter line", () => {
      testCmd("o\ntwo|", "o|\ntwo", cursorLineUp)
    })

    it("goes to the start on first line", () => {
      testCmd("on|e", "|one", cursorLineUp)
    })

    it("keeps a colum pos across a shorter line", () => {
      testCmd("one\nt\nthr|ee", "one|\nt\nthree", v => { cursorLineUp(v); cursorLineUp(v); return true })
    })

    it("can move in a wrapped line", () => {
      testCmd("dandelion dandel|ion dandelion",
              "dandel|ion dandelion dandelion",
              cursorLineUp,
              [EditorView.theme({"&": {maxWidth: "13ch"}}), EditorView.lineWrapping])
    })

    it("isn't affected by folded lines", () => {
      testCmd("one two\nthree four\nfive six\ns|even eight",
              "o|ne two\nthree four\nfive six\nseven eight",
              cursorLineUp,
              EditorView.decorations.of(Decoration.set(Decoration.replace({}).range(5, 26))))
    })

    it("skips block widgets", () => {
      testCmd("one\ntwo\nthree\n|four",
              "|one\ntwo\nthree\nfour",
              cursorLineUp,
              EditorView.decorations.of(Decoration.set(Decoration.replace({widget: w, block: true}).range(4, 13))))
    })

    it("skips multiple block widgets", () => {
      testCmd("one\ntwo\nthree\nfo|ur",
              "on|e\ntwo\nthree\nfour",
              cursorLineUp,
              EditorView.decorations.of(Decoration.set([
                Decoration.replace({widget: w, block: true}).range(4, 7),
                Decoration.replace({widget: w, block: true}).range(8, 13)
              ])))
    })

    it("can escape lines with padding", () => {
      let attributes = {style: "padding-top: 30px 0"}
      testCmd("a\nb|\nc", "a|\nb\nc",
              cursorLineUp,
              EditorView.decorations.of(Decoration.set(Decoration.line({attributes}).range(2))))
    })
  })

  // Randomly executes cursor/select line movement commands, verifying
  // that each move lands on the expected visual line and that vertical
  // moves are reversible by the opposite command.
  describe("movement fuzzing", () => {
    function headY(view: EditorView, pos: number, assoc: -1 | 1) {
      let coords = view.coordsAtPos(pos, assoc)
      return coords ? (coords.top + coords.bottom) / 2 : null
    }

    function actualY(view: EditorView, pos: number, assoc: number) {
      return headY(view, pos, (assoc || 1) as -1 | 1)
    }

    function extremeY(view: EditorView, pos: number, fn: (...values: number[]) => number) {
      let y1 = headY(view, pos, 1), y2 = headY(view, pos, -1)
      if (y1 == null) return y2
      if (y2 == null) return y1
      return fn(y1, y2)
    }

    // Check whether the head moved in the given direction on the visual line.
    // At wrap boundaries, use the most favorable assoc interpretation.
    function movedInDir(view: EditorView, before: Snap, after: Snap, dir: 1 | -1) {
      if ((after.head - before.head) * dir <= 0) return false
      let y1 = extremeY(view, before.head, dir > 0 ? Math.min : Math.max)
      let y2 = extremeY(view, after.head, dir > 0 ? Math.max : Math.min)
      return y1 != null && y2 != null && (y2 - y1) * dir > 2
    }

    function onBoundaryLine(view: EditorView, pos: number, assoc: number, dir: 1 | -1) {
      let y = actualY(view, pos, assoc)
      let boundaryY = headY(view, dir > 0 ? view.state.doc.length : 0, dir > 0 ? -1 : 1)
      return y != null && boundaryY != null && Math.abs(y - boundaryY) <= 2
    }

    function checkAssoc(view: EditorView, before: Snap, after: Snap, dir: 1 | -1): string | null {
      if (after.head == before.head) return null
      let assoc = after.assoc || dir
      let beforeY = actualY(view, before.head, before.assoc)
      let afterY = headY(view, after.head, assoc as -1 | 1)
      if (beforeY == null || afterY == null) return null
      if ((afterY - beforeY) * -dir > 2)
        return `assoc ${after.assoc} resolves head=${after.head} to y=${afterY.toFixed(1)} which is wrong side of before y=${beforeY.toFixed(1)}`
      return null
    }

    type Snap = {head: number, anchor: number, empty: boolean, assoc: number, goalColumn: number | undefined}

    function snap(view: EditorView): Snap {
      let sel = view.state.selection.main
      return {head: sel.head, anchor: sel.anchor, empty: sel.empty, assoc: sel.assoc, goalColumn: sel.goalColumn}
    }

    function showSel(doc: string, s: Snap) {
      let assocStr = s.assoc === -1 ? "←" : s.assoc === 1 ? "→" : "·"
      if (s.head === s.anchor) return doc.slice(0, s.head) + "|" + assocStr + doc.slice(s.head)
      let from = Math.min(s.head, s.anchor), to = Math.max(s.head, s.anchor)
      return doc.slice(0, from) + (s.head < s.anchor ? "<" : "[") +
        doc.slice(from, to) + (s.head < s.anchor ? ">" : "]") + assocStr + doc.slice(to)
    }

    // Build a vertical movement check function parameterized by direction and cursor vs select
    function verticalCheck(dir: 1 | -1, isCursor: boolean) {
      return (view: EditorView, before: Snap, after: Snap): string | null => {
        if (isCursor && !before.empty) return null
        if (!onBoundaryLine(view, before.head, before.assoc, dir)) {
          if (!movedInDir(view, before, after, dir))
            return `head should move ${dir > 0 ? "down" : "up"} (head ${before.head} -> ${after.head})`
          return checkAssoc(view, before, after, dir)
        } else if (isCursor && (after.head - before.head) * -dir > 0) {
          return `on boundary line, should not move ${dir > 0 ? "backward" : "forward"}`
        }
        return null
      }
    }

    type NamedCommand = {name: string, cmd: Command, reverse?: string,
                         check: (view: EditorView, before: Snap, after: Snap) => string | null}

    let commands: NamedCommand[] = [
      {name: "cursorLineDown", cmd: cursorLineDown, reverse: "cursorLineUp",
       check: verticalCheck(1, true)},
      {name: "cursorLineUp", cmd: cursorLineUp, reverse: "cursorLineDown",
       check: verticalCheck(-1, true)},
      {name: "selectLineDown", cmd: selectLineDown, reverse: "selectLineUp",
       check: verticalCheck(1, false)},
      {name: "selectLineUp", cmd: selectLineUp, reverse: "selectLineDown",
       check: verticalCheck(-1, false)},
      {name: "cursorLineBoundaryRight", cmd: cursorLineBoundaryRight,
       check(_, before, after) {
         return !before.empty ? null : after.head < before.head ? `should not move backward` : null
       }},
      {name: "cursorLineBoundaryLeft", cmd: cursorLineBoundaryLeft,
       check(_, before, after) {
         return !before.empty ? null : after.head > before.head ? `should not move forward` : null
       }},
    ]
    let commandsByName: Record<string, NamedCommand> = {}
    for (let c of commands) commandsByName[c.name] = c

    function runFuzz(doc: string, extensions: Extension, iterations: number) {
      let state = mkState("|" + doc, extensions)
      let view = new EditorView({state, parent: document.querySelector("#workspace")! as HTMLElement})
      try {
        let firstY = headY(view, 0, 1), lastY = headY(view, view.state.doc.length, -1)
        if (firstY == null || lastY == null || Math.abs(firstY - lastY) < 2)
          throw new Error("Need multiple visual lines for fuzzing")

        let seed = 42
        function randInt(n: number) {
          seed = (seed * 1664525 + 1013904223) & 0x7fffffff
          return Math.floor((seed / 0x7fffffff) * n)
        }

        let errors: string[] = [], reversibilityErrors = new Map<string, string[]>()
        for (let i = 0; i < iterations && errors.length < 5; i++) {
          let before = snap(view)
          let choice = commands[randInt(commands.length)]
          choice.cmd(view)
          let after = snap(view)

          let err = choice.check(view, before, after)
          if (err) {
            let y1 = actualY(view, before.head, before.assoc), y2 = actualY(view, after.head, after.assoc)
            errors.push(`Step ${i}: ${choice.name} head=${before.head} assoc=${before.assoc} y=${y1?.toFixed(1)}: ${err} (after: y=${y2?.toFixed(1)})`)
          }

          // Reversibility: vertical moves should be undone by the opposite command.
          // Skip boundary lines, no-ops, and cursor commands collapsing selections.
          let reverse = choice.reverse ? commandsByName[choice.reverse] : null
          let isDown = choice.name.includes("Down")
          let isCursor = choice.name.startsWith("cursor")
          if (reverse && after.head !== before.head &&
              !(isCursor && !before.empty) &&
              !onBoundaryLine(view, before.head, before.assoc, isDown ? 1 : -1)) {
            let savedSelection = view.state.selection
            reverse.cmd(view)
            let reversed = view.state.selection.main
            if (reversed.head !== before.head) {
              let y1 = headY(view, before.head, 1), y2 = headY(view, before.head, -1)
              let category = y1 != null && y2 != null && Math.abs(y1 - y2) > 2 ? "wrap-boundary" : "other"
              let docStr = view.state.doc.toString()
              let list = reversibilityErrors.get(category) || []
              reversibilityErrors.set(category, list)
              list.push(`Step ${i}: ${choice.name} then ${reverse.name}\n` +
                `      before:   ${showSel(docStr, before)} goal=${before.goalColumn}\n` +
                `      after:    ${showSel(docStr, after)} goal=${after.goalColumn}\n` +
                `      reversed: ${showSel(docStr, snap(view))} goal=${snap(view).goalColumn}`)
            }
            view.dispatch({selection: savedSelection})
          }
        }

        if (errors.length)
          throw new Error("Fuzzing found errors:\n" + errors.join("\n"))
        if (reversibilityErrors.size) {
          let summary = Array.from(reversibilityErrors.entries())
            .map(([cat, errs]) => `  [${cat}] ${errs.length} failure(s):\n    ` +
              errs.slice(0, 3).join("\n    ") + (errs.length > 3 ? `\n    ... and ${errs.length - 3} more` : ""))
            .join("\n")
          throw new Error(`Reversibility failures by category:\n${summary}`)
        }
      } finally {
        view.destroy()
      }
    }

    it("handles random command sequences in wrapped text", () => {
      runFuzz("dandelion dandelion dandelion two dandelion three",
              [EditorView.theme({"&": {maxWidth: "13ch"}}), EditorView.lineWrapping],
              200)
    })

    it("handles random command sequences with large line height", () => {
      runFuzz("dandelion dandelion dandelion two dandelion three",
              [EditorView.theme({"&": {maxWidth: "13ch"}, ".cm-line": {lineHeight: "3"}}), EditorView.lineWrapping],
              200)
    })

    it("handles random command sequences with multiple doc lines", () => {
      runFuzz("one two three four\nfive six seven eight\nnine ten eleven twelve",
              [EditorView.theme({"&": {maxWidth: "10ch"}}), EditorView.lineWrapping],
              200)
    })
  })
})
