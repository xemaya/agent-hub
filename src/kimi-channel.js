import { InteractiveChannel } from './interactive-channel.js';

export class KimiChannel extends InteractiveChannel {
  constructor(options) { super({ ...options, runtime: 'kimi' }); }
}
