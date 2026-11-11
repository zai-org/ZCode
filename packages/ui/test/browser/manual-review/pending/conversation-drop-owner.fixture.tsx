import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useConversationDropTarget,
  type RegisterConversationDropTarget,
} from "@/v4/composer/conversationDropTarget.js";

function Owner({
  name,
  register,
  report,
}: {
  name: string;
  register: RegisterConversationDropTarget;
  report: (name: string) => void;
}) {
  useLayoutEffect(
    () =>
      register({
        active: true,
        kind: name === "A" ? "attachment" : "workspace",
        onDragOver: (event) => event.preventDefault(),
        onDragLeave: () => report(`${name}:leave`),
        onDrop: (event) => {
          event.preventDefault();
          report(`${name}:drop`);
        },
      }),
    [name, register, report],
  );
  return <div>Composer {name}</div>;
}

function Pane({
  register,
  report,
}: {
  register: RegisterConversationDropTarget;
  report: (name: string) => void;
}) {
  const [controller, bind] = useConversationDropTarget(register);
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  return (
    <section>
      <button onClick={() => setB(true)}>Mount B</button>
      <button onClick={() => setA(false)}>Unmount A</button>
      <button onClick={() => setB(false)}>Unmount B</button>
      <div data-testid="pane" onDrop={controller?.onDrop} onDragOver={controller?.onDragOver}>
        {controller?.kind ?? "none"}
      </div>
      {a && <Owner name="A" register={bind} report={report} />}
      {b && <Owner name="B" register={bind} report={report} />}
    </section>
  );
}

function Fixture() {
  const [controller, register] = useConversationDropTarget();
  const [mounted, setMounted] = useState(true);
  const [lastEvent, report] = useState("");
  return (
    <main>
      <button onClick={() => setMounted((value) => !value)}>Toggle pane</button>
      <div data-testid="header" onDrop={controller?.onDrop} onDragOver={controller?.onDragOver}>
        {controller?.kind ?? "none"}
      </div>
      <output>{lastEvent}</output>
      {mounted && <Pane register={register} report={report} />}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
