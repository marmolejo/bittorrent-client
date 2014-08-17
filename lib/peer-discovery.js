module.exports = PeerDiscovery

var debug = require('debug')('bittorrent-client:peer-discovery')
var DHT = require('bittorrent-dht/client')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var inherits = require('inherits')
var Tracker = require('bittorrent-tracker/client')

inherits(PeerDiscovery, EventEmitter)

function PeerDiscovery (opts) {
  var self = this
  if (!(self instanceof PeerDiscovery)) return new PeerDiscovery(opts)
  EventEmitter.call(self)
  if (!opts) opts = {}

  extend(self, {
    announce: [],
    dht: true,
    externalDHT: false,
    tracker: true,
    torrentPort: null
  }, opts)

  if (!self.peerId) throw new Error('peerId required')

  self._createDHT(opts.dhtOpts, opts.dhtPort)
}

PeerDiscovery.prototype._onPeer = function (addr) {
  var self = this
  self.emit('peer', addr)
}

PeerDiscovery.prototype._dhtLookupAndAnnounce = function () {
  var self = this
  debug('lookup')
  self.dht.lookup(self.infoHash, function (err) {
    if (err || !self.torrentPort) return
    debug('dhtAnnounce')
    self.dht.announce(self.infoHash, self.torrentPort, function () {
      self.emit('dhtAnnounce')
    })
  })
}

PeerDiscovery.prototype._createDHT = function (opts, port) {
  var self = this
  if (self.dht === false) return

  if (self.dht) {
    self.externalDHT = true
  } else {
    self.dht = new DHT(opts)
    self.dht.listen(port)
  }
  self.dht.on('peer', self._onPeer.bind(self))
}

PeerDiscovery.prototype._createTracker = function () {
  var self = this
  if (self.tracker === false) return

  var torrent = self.torrent || {
    infoHash: self.infoHash,
    announce: self.announce
  }

  self.tracker = new Tracker(self.peerId, self.torrentPort, torrent)
  self.tracker.on('peer', self._onPeer.bind(self))
  self.tracker.on('error', function (err) {
    // trackers are optional, so errors like an inaccessible tracker, etc. are not fatal
    self.emit('warning', err)
  })
  self.tracker.start()
}

PeerDiscovery.prototype.setTorrent = function (torrent) {
  var self = this
  debug('setTorrent %s', torrent)

  if (torrent && torrent.infoHash) {
    self.torrent = torrent
    self.infoHash = torrent.infoHash
  } else {
    self.infoHash = torrent
  }

  if (self.tracker && self.tracker !== true) {
    // If tracker exists, then it was created with just infoHash. Set torrent length
    // so client can report correct information about uploads.
    self.tracker.torrentLength = torrent.length
  } else {
    self._createTracker()
  }

  if (self.dht) {
    if (self.dht.ready) self._dhtLookupAndAnnounce()
    else self.dht.on('ready', self._dhtLookupAndAnnounce.bind(self))
  }
}

PeerDiscovery.prototype.stop = function () {
  var self = this
  if (self.tracker) self.tracker.stop()
  if (self.dht && !self.externalDHT) self.dht.destroy()
}
