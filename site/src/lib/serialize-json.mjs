// JSON is data inside a script element: escape HTML delimiters before embedding.
export function serializeJsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
