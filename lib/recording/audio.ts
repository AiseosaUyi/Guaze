/**
 * Mixes one or more audio-only MediaStreams (mic, system audio) into a
 * single track via the Web Audio API, so MediaRecorder only ever sees one
 * audio track no matter how many sources are enabled.
 */
export class AudioMixer {
  private ctx: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private sources: MediaStreamAudioSourceNode[] = [];

  mix(streams: MediaStream[]): MediaStreamTrack | null {
    const withAudio = streams.filter((s) => s.getAudioTracks().length > 0);
    if (withAudio.length === 0) return null;
    if (withAudio.length === 1) {
      // No mixing needed — avoid the AudioContext round-trip and its extra
      // latency/resampling for the common single-source case.
      return withAudio[0].getAudioTracks()[0];
    }

    this.dispose();
    this.ctx = new AudioContext();
    this.destination = this.ctx.createMediaStreamDestination();
    for (const stream of withAudio) {
      const source = this.ctx.createMediaStreamSource(stream);
      source.connect(this.destination);
      this.sources.push(source);
    }
    return this.destination.stream.getAudioTracks()[0] ?? null;
  }

  dispose() {
    this.sources.forEach((s) => s.disconnect());
    this.sources = [];
    this.destination = null;
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close();
    this.ctx = null;
  }
}
