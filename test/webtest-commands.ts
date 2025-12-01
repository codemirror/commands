import {EditorView, Command, Decoration, WidgetType} from "@codemirror/view"
import {Extension, EditorState} from "@codemirror/state"
import {cursorSubwordForward, cursorSubwordBackward, cursorLineDown, cursorLineUp} from "@codemirror/commands"
import ist from "ist"
import {mkState, stateStr} from "./state.js"

const dashWordChar = EditorState.languageData.of(() => [{wordChars: "-"}])

function testCmd(before: string, after: string, command: Command, extensions: Extension = []) {
  let state = mkState(before, extensions)
  let view = new EditorView({
    state,
    parent: document.querySelector("#workspace")! as HTMLElement
  })
  try {
    command(view)
    ist(stateStr(view.state), after)
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
  })
})
