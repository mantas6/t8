; Derived from tree-sitter-html 0.23.2 queries/injections.scm (MIT, see the
; tree-sitter-html package's LICENSE). OpenTUI picks the injected language by
; the captured node type (raw_text -> javascript, set in src/tui/parsers.ts)
; and ignores `#set! injection.language`, so only <script> is injected: a
; <style> block has the same node type and would be parsed as JavaScript.
((script_element
  (raw_text) @injection.content)
 (#set! injection.language "javascript"))
