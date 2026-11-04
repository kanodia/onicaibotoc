// Text for the page

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function escape(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** eg. "2:05" */
export function minutesSeconds(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
