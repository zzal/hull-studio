import { useEffect, useState } from "react";
import { createBlueprint, readTemplates, RouteError, type Template } from "./api.js";

type Props = { onCreated: () => void };

// What `hull studio` shows in a folder without a blueprint: the templates
// the studio writes through its own server. Choosing one writes the file
// and the dashboard loads as if it had always been there.
export function StartScreen({ onCreated }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    readTemplates().then(setTemplates, () => setFailure("the studio is not answering"));
  }, []);

  const choose = async (name: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await createBlueprint(name);
      onCreated();
    } catch (error) {
      setFailure(error instanceof RouteError ? error.response.error : "the studio is not answering");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="start">
      <h1>Hull studio</h1>
      <p>There is no hull.yaml in this folder yet. Start from a template; the studio writes the file and you take it from there.</p>
      <ul className="templates">
        {templates.map((template) => (
          <li key={template.name}>
            <button type="button" disabled={busy} onClick={() => void choose(template.name)}>
              {template.name}
            </button>
            <span>{template.description}</span>
          </li>
        ))}
      </ul>
      {failure && <p className="failure">{failure}</p>}
    </main>
  );
}
