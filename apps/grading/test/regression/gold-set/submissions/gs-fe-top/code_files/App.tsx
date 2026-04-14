import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Top-tier frontend submission</h1>
      <button type="button" onClick={() => setCount(count + 1)}>
        {count}
      </button>
    </main>
  );
}
