import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import "@fontsource-variable/saira/wdth.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "./styles.css";
import schema from "../../shared/race_schema.sql?raw";
import queries from "../../shared/race_queries.sql?raw";
import stream from "../../data/monza-2024.stream.json";
import { RaceDB, type RaceEvent } from "./engine/race.ts";
import { Replay } from "./replay.ts";
import App from "./App.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(<p className="boot">Loading SQLite (WebAssembly) and the race stream…</p>);

initSqlJs({ locateFile: () => wasmUrl })
  .then((SQL) => {
    const db = new RaceDB(SQL, schema, queries, stream.drivers);
    const replay = new Replay(db, stream.events as RaceEvent[]);
    root.render(
      <StrictMode>
        <App boot={{ db, replay, meta: stream as never }} />
      </StrictMode>,
    );
  })
  .catch((e) => root.render(<p className="boot">Could not start the in-browser database: {String(e)}</p>));
