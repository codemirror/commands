import {EditorState, StateCommand, Extension} from "@codemirror/state"
import {indentMore, indentLess, indentSelection,
        insertNewlineAndIndent, insertNewlineKeepIndent,
        deleteTrailingWhitespace, deleteGroupForward, deleteGroupBackward,
        moveLineUp, moveLineDown} from "@codemirror/commands"
import {javascriptLanguage} from "@codemirror/lang-javascript"
import {indentUnit} from "@codemirror/language"
import ist from "ist"
import {mkState, stateStr} from "./state.js"

function cmd(state: EditorState, command: StateCommand) {
  command({state, dispatch(tr) { state = tr.state }})
  return state
}

describe("commands", () => {
  describe("indentMore", () => {
    function test(from: string, to: string) { ist(stateStr(cmd(mkState(from), indentMore)), to) }

    it("adds indentation", () =>
       test("one\ntwo|\nthree", "one\n  two|\nthree"))

    it("indents all lines in a range", () =>
       test("one\n<two\nthree>", "one\n  <two\n  three>"))

    it("doesn't double-indent a given line", () =>
       test("on|e|\n<two\nth><ree\nfour>", "  on|e|\n  <two\n  th><ree\n  four>"))

    it("ignores lines if a range selection ends directly at their start", () =>
      test("on<e\ntwo\n>three", "  on<e\n  two\n>three"))
  })

  describe("indentLess", () => {
    function test(from: string, to: string) { ist(stateStr(cmd(mkState(from), indentLess)), to) }

    it("removes indentation", () =>
       test("one\n  two|\nthree", "one\ntwo|\nthree"))

    it("removes one unit of indentation", () =>
       test("one\n    two|\n     three|", "one\n  two|\n   three|"))

    it("dedents all lines in a range", () =>
       test("one\n  <two\n  three>", "one\n<two\nthree>"))

    it("takes tabs into account", () =>
       test("   \tone|\n  \ttwo|", "  one|\n  two|"))

    it("can split tabs", () =>
       test("\tone|", "  one|"))
  })

  describe("indentSelection", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from, javascriptLanguage), indentSelection)), to)
    }

    it("auto-indents the current line", () =>
       test("if (0)\nfoo()|", "if (0)\n  foo()|"))

    it("moves the cursor ahead of the indentation", () =>
       test("if (0)\n | foo()", "if (0)\n  |foo()"))

    it("indents blocks of lines", () =>
       test("if (0) {\n<one\ntwo\nthree>\n}", "if (0) {\n  <one\n  two\n  three>\n}"))

    it("includes previous indentation changes in relative indentation", () =>
       test("<{\n{\n{\n{}\n}\n}\n}>", "<{\n  {\n    {\n      {}\n    }\n  }\n}>"))
  })

  describe("insertNewlineKeepIndent", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from), insertNewlineKeepIndent)), to)
    }

    it("keeps indentation", () =>
      test("  one|", "  one\n  |"))

    it("keeps zero indentation", () =>
      test("one|two", "one\n|two"))

    it("deletes the selection", () =>
      test("if x:\n  one<two\n  three>four", "if x:\n  one\n  |four"))
  })

  describe("insertNewlineAndIndent", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from, javascriptLanguage), insertNewlineAndIndent)), to)
    }

    it("indents the new line", () =>
       test("{|", "{\n  |"))

    it("can handle multiple selections", () =>
       test("{|\n  foo()|", "{\n  |\n  foo()\n  |"))

    it("isn't confused by text after the cursor", () =>
       test("{|two", "{\n  |two"))

    it("clears empty lines before the cursor", () =>
       test("    |", "\n|"))

    it("deletes selected text", () =>
       test("{<one>two", "{\n  |two"))

    it("can explode brackets", () =>
       test("let x = [|]", "let x = [\n  |\n]"))

    it("can explode in indented positions", () =>
       test("{\n  foo(|)", "{\n  foo(\n    |\n  )"))

    it("can explode brackets with whitespace", () =>
       test("foo( | )", "foo(\n  |\n)"))

    it("doesn't try to explode already-exploded brackets", () =>
       test("foo(\n  |\n)", "foo(\n\n  |\n)"))

    function testIndentationFromPrevLine(from: string, to: string, ext: Extension = []) {
      ist(stateStr(cmd(mkState(from, ext), insertNewlineAndIndent)), to)
    }

    it("doesn't indent when previous line lacks indentation", () =>
       testIndentationFromPrevLine("foo|", "foo\n|"))

    it("indents when previous line uses two space indentation", () =>
       testIndentationFromPrevLine("  foo|", "  foo\n  |"))

    it("indents when previous line uses four space indentation", () =>
       testIndentationFromPrevLine("    foo|", "    foo\n    |"))

    it("indents when previous line uses tab indentation", () =>
       testIndentationFromPrevLine("\tfoo|", "\tfoo\n\t|", indentUnit.of("\t")))

    it("indents when previous line uses tab indentation and short alignment", () =>
       testIndentationFromPrevLine("\t  foo|", "\t  foo\n\t  |", indentUnit.of("\t")))
  })

  describe("deleteTrailingWhitespace", () => {
    function test(from: string, to: string) {
      ist(cmd(mkState(from), deleteTrailingWhitespace).doc.toString(), to)
    }

    it("deletes trailing whitespace", () =>
      test("foo   ", "foo"))

    it("checks multiple lines", () =>
      test("one\ntwo \nthree   \n   ", "one\ntwo\nthree\n"))

    it("can handle empty lines", () =>
      test("one  \n\ntwo ", "one\n\ntwo"))
  })

  describe("deleteGroupForward", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from), deleteGroupForward)), to)
    }

    it("deletes a word", () =>
      test("one |two three", "one | three"))

    it("deletes a word with leading space", () =>
      test("one| two three", "one| three"))

    it("deletes a group of punctuation", () =>
      test("one|...two", "one|two"))

    it("deletes a group of space", () =>
      test("one|  \ttwo", "one|two"))

    it("deletes a newline", () =>
      test("one|\ntwo", "one|two"))

    it("stops deleting at a newline", () =>
      test("one| \n two", "one|\n two"))

    it("stops deleting after a newline", () =>
      test("one|\n two", "one| two"))

    it("deletes up to the end of the doc", () =>
      test("one|two", "one|"))

    it("does nothing at the end of the doc", () =>
      test("one|", "one|"))
  })

  describe("deleteGroupBackward", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from), deleteGroupBackward)), to)
    }

    it("deletes a word", () =>
      test("one two| three", "one | three"))

    it("deletes a word with trailing space", () =>
      test("one two |three", "one |three"))

    it("deletes a group of punctuation", () =>
      test("one...|two", "one|two"))

    it("deletes a group of space", () =>
      test("one \t |two", "one|two"))

    it("deletes a newline", () =>
      test("one\n|two", "one|two"))

    it("stops deleting at a newline", () =>
      test("one \n |two", "one \n|two"))

    it("stops deleting after a newline", () =>
      test("one \n|two", "one |two"))

    it("deletes up to the start of the doc", () =>
      test("one|two", "|two"))
  })

  describe("moveLineUp", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from), moveLineUp)), to)
    }

    it("can move a line up", () =>
      test("one\ntwo|\nthree", "two|\none\nthree"))

    it("preserves multiple cursors on a single line", () =>
      test("one\nt|w|o|\n", "t|w|o|\none\n"))

    it("moves selected blocks as one", () =>
      test("one\ntwo\nthr<ee\nfour\nfive>\n", "one\nthr<ee\nfour\nfive>\ntwo\n"))

    it("moves blocks made of multiple ranges as one", () =>
      test("one\n<two\nth>ree\nfo|u<r\nfive>\n", "<two\nth>ree\nfo|u<r\nfive>\none\n"))

    it("does not include a trailing line after a range", () =>
      test("one\n<two\nthree\n>four", "<two\nthree\n>one\nfour"))
  })

  describe("moveLineDown", () => {
    function test(from: string, to: string) {
      ist(stateStr(cmd(mkState(from), moveLineDown)), to)
    }

    it("can move a line own", () =>
      test("one\ntwo|\nthree", "one\nthree\ntwo|"))

    it("preserves multiple cursors on a single line", () =>
      test("one\nt|w|o|\nthree", "one\nthree\nt|w|o|"))

    it("moves selected blocks as one", () =>
      test("one\ntwo\nthr<ee\nfour\nfive>\nsix", "one\ntwo\nsix\nthr<ee\nfour\nfive>"))

    it("moves blocks made of multiple ranges as one", () =>
      test("one\n<two\nth>ree\nfo|u<r\nfive>\nsix\n", "one\nsix\n<two\nth>ree\nfo|u<r\nfive>\n"))

    it("does not include a trailing line after a range", () =>
      test("one\n<two\nthree\n>four\n", "one\nfour\n<two\nthree\n>"))

    it("clips the selection when moving to the end of the doc", () =>
      test("one\n<two\nthree\n>four", "one\nfour\n<two\nthree>"))
  })
})
