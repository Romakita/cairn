import { useEffect, useState } from "react";
import styles from "./App.module.css";
import { Gallery } from "./gallery/Gallery.tsx";
import { parseGalleryHash } from "./gallery/route.ts";

function useHash(): string {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}

export function App() {
  const gallery = parseGalleryHash(useHash());
  return (
    <main data-testid="app-root" className={styles.root} data-route={gallery ? "gallery" : "app"}>
      {gallery && <Gallery route={gallery} />}
    </main>
  );
}
