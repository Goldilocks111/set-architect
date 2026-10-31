declare module 'music-tempo' {
  export default class MusicTempo {
    constructor(audioData: ArrayLike<number>, params?: Record<string, number>);
    tempo: number | string;
    beats: number[];
  }
}
