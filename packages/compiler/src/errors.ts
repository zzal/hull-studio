// A blueprint the compiler cannot turn into a program: a resolution this
// version does not deploy, an intent without its bundle, an entry without a
// handler. Nothing is compiled.
export class CompileError extends Error {
  override readonly name = "CompileError";
}
