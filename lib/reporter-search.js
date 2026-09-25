/**
 * How far a reporter looks for its console when the port it joined on stops
 * answering: this many ports either side. The console says the same number
 * when its reporting port moves. The certificate is pinned, so a port that
 * answers with any other certificate is passed over and is told nothing.
 */
export const REPORTER_SEARCH = 10;
