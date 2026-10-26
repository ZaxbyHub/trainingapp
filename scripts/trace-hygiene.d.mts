/** Type declarations for trace-hygiene.mjs (issue #183). */
export declare const ERR_REFUSED_MAIN_CHECKOUT: 'TRACE_HYGIENE_REFUSED_MAIN_CHECKOUT';
export declare const ERR_REFUSED_STUB_MAIN_CHECKOUT: 'TRACE_HYGIENE_REFUSED_STUB_MAIN_CHECKOUT';
export declare const ERR_REFUSED_UNRESOLVED_ROOT: 'TRACE_HYGIENE_REFUSED_UNRESOLVED_ROOT';
export declare const ERR_REFUSED_UNRESOLVED_ROOT: 'TRACE_HYGIENE_REFUSED_UNRESOLVED_ROOT';
export declare const ERR_JOURNAL_CORRUPT: 'TRACE_HYGIENE_JOURNAL_CORRUPT';
export declare const ERR_REFUSED_UNRESOLVED_ROOT: 'TRACE_HYGIENE_REFUSED_UNRESOLVED_ROOT';
export declare const ERR_JOURNAL_CORRUPT: 'TRACE_HYGIENE_JOURNAL_CORRUPT';
export declare const ERR_REFUSED_UNRESOLVED_ROOT: 'TRACE_HYGIENE_REFUSED_UNRESOLVED_ROOT';
export declare const ERR_JOURNAL_CORRUPT: 'TRACE_HYGIENE_JOURNAL_CORRUPT';
export declare const ERR_JUNCTION_LEFT: 'TRACE_HYGIENE_JUNCTION_LEFT';
export declare class TraceHygieneRefused extends Error {
  code: string;
  name: 'TraceHygieneRefused';
  constructor(code: string, message: string);
}
export declare function canonicalPath(p: string): string;
export declare function resolveMainRoot(repoRoot: string): string;
export declare function isInsideMainCheckout(candidate: string, mainRoot: string): boolean;
export declare function assertNotMainCheckout(repoRoot: string): string;
export declare function assertStubPlantAllowed(opts: { repoRoot: string; packagePath: string }): string;
export declare function createJunction(link: string, target: string, journalPath: string): {
  link: string;
  target: string;
  pid: number;
};
export declare function removeJournaledJunctions(journalPath: string): number; // entries processed (already-gone links count as processed) // entries processed (already-gone links count as processed) // entries processed (already-gone links count as processed)
export declare function main(argv: string[]): 0; // throws TraceHygieneRefused on refusal; the entry guard maps that to exit 2
