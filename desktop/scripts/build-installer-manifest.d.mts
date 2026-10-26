/** Type declarations for build-installer-manifest.mjs (the CLI surface stays
 *  untyped; only the exported seam the committed specs import is declared). */
export declare function sha256File(absolutePath: string): Promise<string>;
declare const entryGuard: unique symbol;
export {};
