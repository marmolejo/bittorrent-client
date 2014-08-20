// TODO: dhtPort and torrentPort should be consistent between restarts
// TODO: peerId and nodeId should be consistent between restarts

module.exports = Client

var debug = require('debug')('bittorrent-client')
var DHT = require('bittorrent-dht/client') // empty object in browser
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var hat = require('hat')
var inherits = require('inherits')
var ipSet = require('ip-set')
var parallel = require('run-parallel')
var parseTorrent = require('parse-torrent')
var speedometer = require('speedometer')
var Storage = require('./lib/storage')
var Torrent = require('./lib/torrent')

inherits(Client, EventEmitter)

/**
 * Torrent client
 * @param {Object} opts
 */
function Client (opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(opts)
  EventEmitter.call(self)
  if (!opts) opts = {}

  extend(self, {
    peerId: new Buffer('-WW0001-' + hat(48), 'utf8'),
    nodeId: new Buffer(hat(160), 'hex'),
    dht: (typeof DHT === 'function'), // will be false in browser until webtorrent-dht is implemented
    tracker: true,
    torrentPort: undefined
  }, opts)

  self.peerId = typeof self.peerId === 'string'
    ? new Buffer(self.peerId, 'utf8')
    : self.peerId
  self.peerIdHex = self.peerId.toString('hex')

  self.nodeId = typeof self.nodeId === 'string'
    ? new Buffer(self.nodeId, 'hex')
    : self.nodeId
  self.nodeIdHex = self.nodeId.toString('hex')

  debug('new client peerId %s nodeId %s', self.peerIdHex, self.nodeIdHex)

  self.blocked = ipSet(opts.blocklist)
  self.torrents = []
  self.downloadSpeed = speedometer()
  self.uploadSpeed = speedometer()

  if (self.dht) {
    self.dht = new DHT(extend({ nodeId: self.nodeId }, self.dht))
    self.dht.listen(opts.dhtPort)
  }
}

Client.Storage = Storage

/**
 * Aggregate seed ratio for all torrents in the client.
 * @type {number}
 */
Object.defineProperty(Client.prototype, 'ratio', {
  get: function () {
    var self = this

    var uploaded = self.torrents.reduce(function (total, torrent) {
      return total + torrent.uploaded
    }, 0)
    var downloaded = self.torrents.reduce(function (total, torrent) {
      return total + torrent.downloaded
    }, 0)

    if (downloaded === 0) return 0
    else return uploaded / downloaded
  }
})

/**
 * Return the torrent with the given `torrentId`. Easier than searching through the
 * `client.torrents` array by hand for the torrent you want.
 * @param  {string|Buffer} torrentId
 * @return {Torrent}
 */
Client.prototype.get = function (torrentId) {
  var self = this
  var parsed = parseTorrent(torrentId)
  if (!parsed || !parsed.infoHash) return null
  for (var i = 0, len = self.torrents.length; i < len; i++) {
    var torrent = self.torrents[i]
    if (torrent.infoHash === parsed.infoHash) return torrent
  }
  return null
}

/**
 * Add a new torrent to the client. `torrentId` can be one of:
 *
 * - magnet uri (utf8 string)
 * - torrent file (buffer)
 * - info hash (hex string or buffer)
 * - parsed torrent (from parse-torrent module)
 *
 * @param {string|Buffer|Object} torrentId torrent (choose from above list)
 * @param {Object}               opts      optional torrent-specific options
 * @param {function=}            ontorrent called when the torrent is ready (has metadata)
 */
Client.prototype.add = function (torrentId, opts, ontorrent) {
  var self = this
  debug('add %s', torrentId)
  if (typeof opts === 'function') {
    ontorrent = opts
    opts = {}
  }

  function clientOnTorrent (_torrent) {
    if (torrent.infoHash === _torrent.infoHash) {
      ontorrent(torrent)
      self.removeListener('torrent', clientOnTorrent)
    }
  }
  if (ontorrent) self.on('torrent', clientOnTorrent)

  var torrent = new Torrent(torrentId, extend({ client: self }, opts))
  self.torrents.push(torrent)

  torrent.on('error', function (err) {
    self.emit('error', err, torrent)
  })

  torrent.on('listening', function (port) {
    self.emit('listening', port, torrent)
  })

  torrent.on('ready', function () {
    // Emit 'torrent' when a torrent is ready to be used
    debug('torrent')
    self.emit('torrent', torrent)
  })

  return torrent
}

/**
 * Remove a torrent from the client. Destroy all connections to peers and delete all
 * saved file data. Optional callback is called when file data has been removed.
 * @param  {string|Buffer}   torrentId
 * @param  {function} cb
 */
Client.prototype.remove = function (torrentId, cb) {
  var self = this
  var torrent = self.get(torrentId)
  if (!torrent) throw new Error('No torrent with id ' + torrentId)
  debug('remove')
  self.torrents.splice(self.torrents.indexOf(torrent), 1)
  torrent.destroy(cb)
}

/**
 * Destroy the client, including all torrents and connections to peers.
 * @param  {function} cb
 */
Client.prototype.destroy = function (cb) {
  var self = this
  debug('destroy')

  var tasks = self.torrents.map(function (torrent) {
    return function (cb) {
      self.remove(torrent.infoHash, cb)
    }
  })

  if (self.dht) tasks.push(function (cb) {
    self.dht.destroy(cb)
  })

  parallel(tasks, cb)
}
