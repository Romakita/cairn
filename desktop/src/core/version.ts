import pkg from "../../package.json" with { type: "json" };

/** Version de Cairn : celle de package.json, injectée au build (source unique). */
export const CAIRN_VERSION: string = pkg.version;
