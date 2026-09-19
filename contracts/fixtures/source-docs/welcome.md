# Getting Started

Welcome to the test pack source corpus. This document is one of the plain
source documents that `packtool build-docs` turns into a fully conformant
Knowledge Pack with prebuilt embeddings and FTS, so that installing the pack
never re-embeds content client-side.

## Why prebuilt indexes matter

End-user machines install packs; they do not pay the embedding cost at
install time. The build machine does the work once, and every client gets
byte-identical, ready-to-query content.
