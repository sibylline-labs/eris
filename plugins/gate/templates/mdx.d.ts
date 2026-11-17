/** `.mdx` receipt templates are imported as text (`with { type: "text" }`) and embedded by `bun build --compile`. */
declare module "*.mdx" {
  const text: string;
  export default text;
}
