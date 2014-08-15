module.exports = Client

var debug = require('debug')('bittorrent-client')
var DHT = require('bittorrent-dht/client')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var hat = require('hat')
var inherits = require('inherits')
var magnet = require('magnet-uri')
var parallel = require('run-parallel')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var speedometer = require('speedometer')
var Storage = require('./lib/storage')
var Torrent = require('./lib/torrent')

portfinder.basePort = Math.floor(Math.random() * 64000) + 1025 // pick port >1024

inherits(Client, EventEmitter)

/**
 * Create a new `bittorrent-client` instance. Available options described in the README.
 * @param {Object} opts
 */
function Client (opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(opts)
  EventEmitter.call(self)

  // default options
  opts = extend({
    dht: true,
    trackers: true
  }, opts)

  // TODO: these ids should be consistent between restarts!
  self.peerId = opts.peerId || new Buffer('-WW0001-' + hat(48), 'utf8')
  self.nodeId = opts.nodeId || new Buffer(hat(160), 'hex')

  // TODO: DHT port should be consistent between restarts
  self.dhtPort = opts.dhtPort
  self.torrentPort = opts.torrentPort

  debug('new client peerId %s nodeId %s dhtPort %s torrentPort %s', self.peerId,
      self.nodeId, self.dhtPort, self.torrentPort)

  self.trackersEnabled = opts.trackers

  self.ready = false
  self.torrents = []
  self.blocklist = opts.blocklist || []

  self.downloadSpeed = speedometer()
  self.uploadSpeed = speedometer()

  var tasks = []

  if (!self.torrentPort) {
    // TODO: move portfinder stuff into bittorrent-swarm, like how
    // it works with bittorrent-dht
    tasks.push(function (cb) {
      portfinder.getPort(function (err, port) {
        self.torrentPort = port
        cb(err)
      })
    })
  }

  if (opts.dht) {
    tasks.push(function (cb) {
      self.dht = new DHT(extend({ nodeId: self.nodeId }, opts.dht))
      self.dht.on('peer', self._onDHTPeer.bind(self))
      self.dht.on('listening', function (port) {
        self.dhtPort = port
      })
      self.dht.on('ready', function () {
        cb()
      })
      self.dht.listen(self.dhtPort)
    })
  }

  parallel(tasks, function (err) {
    if (err) return self.emit('error', err)
    self.ready = true
    self.emit('ready')
    debug('ready')
  })
}

Client.Storage = Storage

/**
 * Given a torrentId, return a hex string.
 * @param  {string|Buffer} torrentId magnet uri, torrent file, infohash, or parsed torrent
 * @return {string} info hash (hex string)
 */
Client.toInfoHash = function (torrentId) {
  if (typeof torrentId === 'string') {
    if (!/^magnet:/.test(torrentId) && torrentId.length === 40 || torrentId.length === 32) {
      // info hash (hex/base-32 string)
      torrentId = 'magnet:?xt=urn:btih:' + torrentId
    }
    // magnet uri
    var info = magnet(torrentId)
    return info && info.infoHash
  } else if (Buffer.isBuffer(torrentId)) {
    if (torrentId.length === 20) {
      // info hash (buffer)
      return torrentId.toString('hex')
    } else {
      // torrent file
      try {
        return parseTorrent(torrentId).infoHash
      } catch (err) {
        return null
      }
    }
  } else if (torrentId && torrentId.infoHash) {
    // parsed torrent (from parse-torrent module)
    return torrentId.infoHash
  } else {
    return null
  }
}

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
  var infoHash = Client.toInfoHash(torrentId)
  for (var i = 0, len = self.torrents.length; i < len; i++) {
    var torrent = self.torrents[i]
    if (torrent.infoHash === infoHash) {
      return torrent
    }
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
  if (!self.ready)
    return self.once('ready', self.add.bind(self, torrentId, opts, ontorrent))

  if (typeof opts === 'function') {
    ontorrent = opts
    opts = {}
  }

  debug('add')

  var torrent = new Torrent(torrentId, extend({
    blocklist: self.blocklist,
    dht: !!self.dht,
    dhtPort: self.dhtPort,
    peerId: self.peerId,
    torrentPort: self.torrentPort,
    trackers: self.trackersEnabled
  }, opts))

  self.torrents.push(torrent)


  function clientOnTorrent (_torrent) {
    if (torrent.infoHash === _torrent.infoHash) {
      ontorrent(torrent)
      self.removeListener('torrent', clientOnTorrent)
    }
  }
  if (ontorrent) self.on('torrent', clientOnTorrent)

  process.nextTick(function () {
    self.emit('addTorrent', torrent)
  })

  torrent.on('listening', function () {
    self.emit('listening', torrent)
  })

  torrent.on('error', function (err) {
    self.emit('error', err)
  })

  torrent.on('metadata', function () {
    // Call callback and emit 'torrent' when a torrent is ready to be used
    self.emit('torrent', torrent)
    debug('torrent')
  })

  torrent.swarm.on('download', function (downloaded) {
    self.downloadSpeed(downloaded)
  })
  torrent.swarm.on('upload', function (uploaded) {
    self.uploadSpeed(uploaded)
  })

  if (self.dht) {
    self.dht.lookup(torrent.infoHash, function (err) {
      if (err) return
      self.dht.announce(torrent.infoHash, self.torrentPort, function () {
        torrent.emit('announce')
      })
    })
  }
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
  if (self.dht) self.dht.destroy()

  var tasks = self.torrents.map(function (torrent) {
    return function (cb) {
      self.remove(torrent.infoHash, cb)
    }
  })

  parallel(tasks, cb)
}

// TODO: move into bittorrent-swarm
Client.prototype._onDHTPeer = function (addr, infoHash) {
  var self = this
  var torrent = self.get(infoHash)
  torrent.addPeer(addr)
}
