/**
 * Globals the DSH client runtime installs before a plugin module runs. The
 * panel bundle is plain JS served as-is, so this declaration is the only thing
 * that tells the type checker about them.
 */
interface Window {
  __ModuleLoader__: {
    load: (definition: { id: string, factory: (require: (id: string) => any) => any }) => void
  }
}
