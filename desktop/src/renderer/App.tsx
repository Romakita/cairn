import { useEffect, useState } from "react";
import styles from "./App.module.css";
import { Gallery } from "./gallery/Gallery.tsx";
import { parseGalleryHash } from "./gallery/route.ts";
import { MenuBarPanel } from "./screens/menubar/MenuBarPanel.tsx";
import { Shell } from "./screens/shell/Shell.tsx";

function useHash(): string {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}

/** Trois pages : la galerie (#/gallery), le panneau de la barre des menus (#/menubar) et l'app. */
export function App() {
  const hash = useHash();
  const gallery = parseGalleryHash(hash);
  const route = gallery ? "gallery" : hash.startsWith("#/menubar") ? "menubar" : "app";
  return (
    <main data-testid="app-root" className={styles.root} data-route={route}>
      {gallery && <Gallery route={gallery} />}
      {route === "menubar" && <MenuBarPanel />}
      {route === "app" && <Shell />}
    </main>
  );
}
