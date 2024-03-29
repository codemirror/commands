import {EditorState, EditorSelection, Extension} from "@codemirror/state"

export function mkState(doc: string, extensions: Extension = []) {
  let range = /\||<([^]*?)>/g, m
  let ranges = []
  while (m = range.exec(doc)) {
    if (m[1]) {
      ranges.push(EditorSelection.range(m.index, m.index + m[1].length))
      doc = doc.slice(0, m.index) + doc.slice(m.index + 1, m.index + 1 + m[1].length) + doc.slice(m.index + m[0].length)
      range.lastIndex -= 2
    } else {
      ranges.push(EditorSelection.cursor(m.index))
      doc = doc.slice(0, m.index) + doc.slice(m.index + 1)
      range.lastIndex--
    }
  }
  return EditorState.create({
    doc,
    selection: ranges.length ? EditorSelection.create(ranges) : undefined,
    extensions: [extensions, EditorState.allowMultipleSelections.of(true)]
  })
}

export function stateStr(state: EditorState) {
  let doc = state.doc.toString()
  for (let i = state.selection.ranges.length - 1; i >= 0; i--) {
    let range = state.selection.ranges[i]
    if (range.empty)
      doc = doc.slice(0, range.from) + "|" + doc.slice(range.from)
    else
      doc = doc.slice(0, range.from) + "<" + doc.slice(range.from, range.to) + ">" + doc.slice(range.to)
  }
  return doc
}
