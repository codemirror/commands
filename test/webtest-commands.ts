import {EditorView, Command} from "@codemirror/view"
import {Extension, EditorState} from "@codemirror/state"
import {cursorSubwordForward, cursorSubwordBackward} from "@codemirror/commands"
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
})
