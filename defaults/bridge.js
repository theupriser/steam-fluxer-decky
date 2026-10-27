// Injected into the Fluxer page over CDP. Finds Fluxer's stores in the rspack
// bundle by method names (module ids and mangled names change per build) and
// exposes a small API on window.__fluxerDeck. Never returns tokens or any
// stored account data: only ids and display names.
(() => {
  const VERSION = 1;
  if (window.__fluxerDeck && window.__fluxerDeck.v === VERSION) return window.__fluxerDeck;

  const GUILD_VOICE = 2;
  let req;
  rspackChunkfluxer_app.push([[Symbol('deck')], {}, (r) => { req = r; }]);

  const cache = {};
  // Find the exported object that has all of the given methods.
  const find = (name, methods) => {
    if (cache[name]) return cache[name];
    for (const [id, factory] of Object.entries(req.m)) {
      const src = factory.toString();
      if (!methods.every((m) => src.includes(m))) continue;
      let mod;
      try { mod = req(id); } catch { continue; }
      for (const k of Object.keys(mod)) {
        let v;
        try { v = mod[k]; } catch { continue; }
        if (v && (typeof v === 'object' || typeof v === 'function') && methods.every((m) => typeof v[m] === 'function')) {
          return (cache[name] = v);
        }
      }
    }
    throw new Error('fluxer store not found: ' + name);
  };
  const accounts = () => find('accounts', ['switchToAccount', 'getAccount']);
  const media = () => find('media', ['connectToVoiceChannel', 'disconnectFromVoiceChannel']);
  const voice = () => find('voice', ['toggleSelfMute', 'toggleSelfDeaf']);
  const guilds = () => find('guilds', ['getGuildIds', 'getGuild']);
  const channels = () => find('channels', ['getGuildChannels', 'getPrivateChannels']);

  const api = {
    v: VERSION,
    state() {
      const m = media();
      const v = voice();
      const g = guilds();
      const c = channels();
      const guildList = g.getGuildIds().map((id) => {
        const guild = g.getGuild(id);
        const voiceChannels = c
          .getGuildChannels(id)
          .filter((ch) => ch.type === GUILD_VOICE)
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .map((ch) => ({ id: ch.id, name: ch.name }));
        return { id, name: guild && guild.name, voiceChannels };
      }).filter((x) => x.voiceChannels.length > 0);
      let channelName = null;
      if (m.channelId) {
        const ch = c.getChannel(m.channelId);
        channelName = ch && ch.name;
      }
      return {
        currentAccountKey: accounts().currentAccountKey,
        voice: {
          channelId: m.channelId || null,
          channelName,
          connected: !!m.connected,
          connecting: !!m.connecting,
          selfMute: !!v.getSelfMute(),
          selfDeaf: !!v.getSelfDeaf(),
        },
        guilds: guildList,
      };
    },
    join(channelId) { media().connectToVoiceChannel(null, channelId); },
    leave() { return media().disconnectFromVoiceChannel('user'); },
    toggleMute() { voice().toggleSelfMute(); },
    toggleDeafen() { voice().toggleSelfDeaf(); },
    switchAccount(accountKey) { return accounts().switchToAccount(accountKey); },
  };
  window.__fluxerDeck = api;
  return api;
})();
