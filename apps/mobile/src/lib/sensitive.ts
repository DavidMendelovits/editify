/**
 * Marks a node as showing something the user wrote or something transcribed
 * from their footage: a caption line, a chat turn, a filename, a project title.
 *
 * The screenshot in a report is published to the issue tracker, and the server
 * already masks exactly this content out of the repro bundle. Without a marker
 * the picture would put it all back: a screenshot of the editor carries the
 * burned-in captions, which are the words someone said on camera.
 *
 * RN Web turns `dataSet` into `data-*` attributes, which is what the capture
 * looks for. On native it is inert, and there is no capture there either.
 */
export const sensitive = { dataSet: { editifySensitive: 'true' } } as const;
