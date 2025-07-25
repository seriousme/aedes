import { test } from 'tap'
import memory from 'aedes-persistence'
import Faketimers from '@sinonjs/fake-timers'
import { setup, connect, noError, delay } from './helper.js'
import { Aedes } from '../aedes.js'

async function memorySetup (opts) {
  const persistence = memory()
  await persistence.setup(opts)
  return persistence
}

function willConnect (s, opts, connected) {
  opts = opts || {}
  opts.will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  return connect(s, opts, connected)
}

test('delivers a will', function (t) {
  t.plan(4)

  Aedes.createBroker().then((broker) => {
    const opts = {}
    // willConnect populates opts with a will
    const s = willConnect(setup(broker),
      opts,
      function () {
        s.conn.destroy()
      }
    )
    t.teardown(s.broker.close.bind(s.broker))

    s.broker.mq.on('mywill', function (packet, cb) {
      t.equal(packet.topic, opts.will.topic, 'topic matches')
      t.same(packet.payload, opts.will.payload, 'payload matches')
      t.equal(packet.qos, opts.will.qos, 'qos matches')
      t.equal(packet.retain, opts.will.retain, 'retain matches')
      cb()
    })
  })
})

test('calling close two times should not deliver two wills', function (t) {
  t.plan(4)

  Aedes.createBroker().then((broker) => {
    const opts = {}
    t.teardown(broker.close.bind(broker))

    broker.on('client', function (client) {
      client.close()
      client.close()
    })

    broker.mq.on('mywill', onWill)

    // willConnect populates opts with a will
    willConnect(setup(broker), opts)

    function onWill (packet, cb) {
      broker.mq.removeListener('mywill', onWill, function () {
        broker.mq.on('mywill', function (packet) {
          t.fail('the will must be delivered only once')
        })
      })
      t.equal(packet.topic, opts.will.topic, 'topic matches')
      t.same(packet.payload, opts.will.payload, 'payload matches')
      t.equal(packet.qos, opts.will.qos, 'qos matches')
      t.equal(packet.retain, opts.will.retain, 'retain matches')
      cb()
    }
  })
})

test('delivers old will in case of a crash', function (t) {
  t.plan(7)

  memorySetup({ id: 'anotherBroker' })
    .then(persistence => {
      const will = {
        topic: 'mywill',
        payload: Buffer.from('last will'),
        qos: 0,
        retain: false
      }
      persistence.putWill({ id: 'myClientId42' }, will)
        .then(() => {
          let authorized = false
          const interval = 10 // ms, so that the will check happens fast!
          Aedes.createBroker({
            persistence,
            heartbeatInterval: interval,
            authorizePublish: function (client, packet, callback) {
              t.strictSame(client, null, 'client must be null')
              authorized = true
              callback(null)
            }
          })
            .then((broker) => {
              t.teardown(broker.close.bind(broker))

              const start = Date.now()

              broker.mq.on('mywill', check)

              function check (packet, cb) {
                broker.mq.removeListener('mywill', check, function () {
                  broker.mq.on('mywill', function (packet) {
                    t.fail('the will must be delivered only once')
                  })
                })
                t.ok(Date.now() - start >= 3 * interval, 'the will needs to be emitted after 3 heartbeats')
                t.equal(packet.topic, will.topic, 'topic matches')
                t.same(packet.payload, will.payload, 'payload matches')
                t.equal(packet.qos, will.qos, 'qos matches')
                t.equal(packet.retain, will.retain, 'retain matches')
                t.equal(authorized, true, 'authorization called')
                cb()
              }
            })
            .catch(err => t.error(err, 'no error'))
        })
    })
})

test('deliver old will without authorization in case of a crash', function (t) {
  t.plan(1)

  memorySetup({ id: 'anotherBroker' })
    .then(persistence => {
      const will = {
        topic: 'mywill',
        payload: Buffer.from('last will'),
        qos: 0,
        retain: false
      }

      persistence.putWill({ id: 'myClientId42' }, will)
        .then(() => {
          const interval = 10 // ms, so that the will check happens fast!
          Aedes.createBroker({
            persistence,
            heartbeatInterval: interval,
            authorizePublish: function (client, packet, callback) {
              t.strictSame(client, null, 'client must be null')
              callback(new Error())
            }
          }).then((broker) => {
            t.teardown(broker.close.bind(broker))
            broker.mq.on('mywill', check)

            function check (packet, cb) {
              t.fail('received will without authorization')
              cb()
            }
          })
            .catch(err => t.error(err, 'no error'))
        })
    })
})

test('delete old broker', function (t) {
  t.plan(1)

  const clock = Faketimers.install()

  const heartbeatInterval = 100
  Aedes.createBroker({
    heartbeatInterval
  }).then((broker) => {
    t.teardown(broker.close.bind(broker))

    const brokerId = 'dummyBroker'

    broker.brokers[brokerId] = Date.now() - heartbeatInterval * 3.5

    setTimeout(() => {
      t.equal(broker.brokers[brokerId], undefined, 'Broker deleted')
    }, heartbeatInterval * 4)

    clock.tick(heartbeatInterval * 4)

    clock.uninstall()
  })
})

test('store the will in the persistence', function (t) {
  t.plan(4)

  const opts = {
    clientId: 'abcde'
  }

  Aedes.createBroker().then((broker) => {
    // willConnect populates opts with a will
    const s = willConnect(setup(broker), opts)
    t.teardown(s.broker.close.bind(s.broker))

    s.broker.on('client', function () {
      // this is connack
      s.broker.persistence.getWill({ id: opts.clientId })
        .then(packet => {
          t.same(packet.topic, opts.will.topic, 'will topic matches')
          t.same(packet.payload, opts.will.payload, 'will payload matches')
          t.same(packet.qos, opts.will.qos, 'will qos matches')
          t.same(packet.retain, opts.will.retain, 'will retain matches')
        })
        .catch(err => t.error(err, 'no error'))
    })
  })
})

test('delete the will in the persistence after publish', function (t) {
  t.plan(1)

  const opts = {
    clientId: 'abcde'
  }

  Aedes.createBroker().then((broker) => {
    t.teardown(broker.close.bind(broker))

    broker.on('client', function (client) {
      setImmediate(function () {
        client.close()
      })
    })

    broker.mq.on('mywill', check)

    // willConnect populates opts with a will
    willConnect(setup(broker), opts)

    function check (packet, cb) {
      broker.mq.removeListener('mywill', check, function () {
        broker.persistence.getWill({ id: opts.clientId })
          .then(p => t.notOk(p, 'packet is empty'))
          .catch(err => t.error(err, 'no error'))
      })
      cb()
    }
  })
})

test('delivers a will with authorization', function (t) {
  t.plan(6)

  let authorized = false

  Aedes.createBroker({
    authorizePublish: (client, packet, callback) => {
      authorized = true
      callback(null)
    }
  }).then((broker) => {
    const opts = {}
    // willConnect populates opts with a will
    const s = willConnect(
      setup(broker),
      opts,
      function () {
        s.conn.destroy()
      }
    )
    t.teardown(s.broker.close.bind(s.broker))

    s.broker.on('clientDisconnect', function (client) {
      t.equal(client.connected, false)
    })

    s.broker.mq.on('mywill', function (packet, cb) {
      t.equal(packet.topic, opts.will.topic, 'topic matches')
      t.same(packet.payload, opts.will.payload, 'payload matches')
      t.equal(packet.qos, opts.will.qos, 'qos matches')
      t.equal(packet.retain, opts.will.retain, 'retain matches')
      t.equal(authorized, true, 'authorization called')
      cb()
    })
  })
})

test('delivers a will waits for authorization', function (t) {
  t.plan(6)

  let authorized = false
  Aedes.createBroker({
    authorizePublish: (client, packet, callback) => {
      authorized = true
      setImmediate(() => { callback(null) })
    }
  }).then((broker) => {
    const opts = {}
    // willConnect populates opts with a will
    const s = willConnect(
      setup(broker),
      opts,
      function () {
        s.conn.destroy()
      }
    )
    t.teardown(s.broker.close.bind(s.broker))

    s.broker.on('clientDisconnect', function () {
      t.pass('client is disconnected')
    })

    s.broker.mq.on('mywill', function (packet, cb) {
      t.equal(packet.topic, opts.will.topic, 'topic matches')
      t.same(packet.payload, opts.will.payload, 'payload matches')
      t.equal(packet.qos, opts.will.qos, 'qos matches')
      t.equal(packet.retain, opts.will.retain, 'retain matches')
      t.equal(authorized, true, 'authorization called')
      cb()
    })
  })
})

test('does not deliver a will without authorization', function (t) {
  t.plan(1)

  let authorized = false
  Aedes.createBroker({
    authorizePublish: (username, packet, callback) => {
      authorized = true
      callback(new Error())
    }
  }).then((broker) => {
    const opts = {}
    // willConnect populates opts with a will
    const s = willConnect(
      setup(broker),
      opts,
      function () {
        s.conn.destroy()
      }
    )
    t.teardown(s.broker.close.bind(s.broker))

    s.broker.on('clientDisconnect', function () {
      t.equal(authorized, true, 'authorization called')
    })

    s.broker.mq.on('mywill', function (packet, cb) {
      t.fail('received will without authorization')
      cb()
    })
  })
})

test('does not deliver a will without authentication', function (t) {
  t.plan(1)

  let authenticated = false
  Aedes.createBroker({
    authenticate: (client, username, password, callback) => {
      authenticated = true
      callback(new Error(), false)
    }
  }).then((broker) => {
    const opts = {}
    // willConnect populates opts with a will
    const s = willConnect(
      setup(broker),
      opts
    )
    t.teardown(s.broker.close.bind(s.broker))

    s.broker.on('clientError', function () {
      t.equal(authenticated, true, 'authentication called')
      t.end()
    })

    s.broker.mq.on('mywill', function (packet, cb) {
      t.fail('received will without authentication')
      cb()
    })
  })
})

test('does not deliver will if broker is closed during authentication', function (t) {
  t.plan(0)

  const opts = { keepalive: 1 }
  let brokerClose

  Aedes.createBroker({
    authenticate: function (client, username, password, callback) {
      setTimeout(function () {
        callback(null, true)
      })
      brokerClose()
    }
  }).then((broker) => {
    brokerClose = broker.close.bind(broker)

    broker.on('keepaliveTimeout', function () {
      t.fail('keepalive timer shoud not be set')
    })

    broker.mq.on('mywill', function (packet, cb) {
      t.fail('Received will when it was not expected')
      cb()
    })

    willConnect(setup(broker), opts)
  })
})

// [MQTT-3.14.4-3]
test('does not deliver will when client sends a DISCONNECT', function (t) {
  t.plan(1)

  Aedes.createBroker().then(async (broker) => {
    t.teardown(broker.close.bind(broker))

    const s = noError(willConnect(setup(broker), {}, async function () {
      s.inStream.write({
        cmd: 'disconnect'
      })
      // give disconnect some time to properly disconnect
      // before the stream is closed
      await delay(10)
      t.pass('disconnected')
    }), t)

    s.broker.mq.on('mywill', function (packet, cb) {
      t.fail(packet, 'received the will that we should not get')
      cb()
    })
  })
})

test('deletes from persistence on DISCONNECT', function (t) {
  t.plan(1)

  const opts = {
    clientId: 'abcde'
  }
  Aedes.createBroker().then((broker) => {
    t.teardown(broker.close.bind(broker))

    const s = noError(willConnect(setup(broker), opts, function () {
      s.inStream.end({
        cmd: 'disconnect'
      })
    }), t)

    s.broker.persistence.getWill({ id: opts.clientId })
      .then(packet => t.notOk(packet))
      .catch(err => t.error(err, 'no error'))
  })
})

test('does not store multiple will with same clientid', function (t) {
  t.plan(2)

  const opts = { clientId: 'abcde' }

  Aedes.createBroker().then((broker) => {
    let s = noError(willConnect(setup(broker), opts, function () {
      // gracefully close client so no will is sent
      s.inStream.end({
        cmd: 'disconnect'
      })
    }), t)

    broker.on('clientDisconnect', function (client) {
      // reconnect same client with will
      s = willConnect(setup(broker), opts, function () {
        // check that there are not 2 will messages for the same clientid
        s.broker.persistence.delWill({ id: opts.clientId })
          .then(packet => {
            t.equal(packet.clientId, opts.clientId, 'will packet found')
            s.broker.persistence.delWill({ id: opts.clientId })
              .then(packet => {
                t.equal(!!packet, false, 'no duplicated packets')
                broker.close()
              })
              .catch(err => t.error(err, 'no error'))
          })
          .catch(err => t.error(err, 'no error'))
      })
    })
  })
})

test('don\'t delivers a will if broker alive', function (t) {
  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  const oldBroker = 'broker1'

  memorySetup({ id: oldBroker }).then(persistence => {
    persistence.putWill({ id: 'myClientId42' }, will)
      .then(() => {
        const opts = {
          persistence,
          heartbeatInterval: 10
        }

        let count = 0

        Aedes.createBroker(opts).then((broker) => {
          t.teardown(broker.close.bind(broker))

          const streamWill = persistence.streamWill
          persistence.streamWill = function () {
            // don't pass broker.brokers to streamWill
            return streamWill.call(persistence)
          }

          broker.mq.on('mywill', function (packet, cb) {
            t.fail('Will received')
            cb()
          })

          broker.mq.on('$SYS/+/heartbeat', function () {
            t.pass('Heartbeat received')
            broker.brokers[oldBroker] = Date.now()

            if (++count === 5) {
              t.end()
            }
          })
        })
          .catch(err => t.error(err, 'no error'))
      })
  })
})

test('handle will publish error', function (t) {
  t.plan(1)

  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: false
  }

  memorySetup({ id: 'broker1' }).then(persistence => {
    persistence.putWill({ id: 'myClientId42' }, will)
      .then(() => {
        const opts = {
          persistence,
          heartbeatInterval: 10
        }

        persistence.delWill = async function (client) {
          throw new Error('Throws error')
        }

        Aedes.createBroker(opts)
          .then((broker) => {
            t.teardown(broker.close.bind(broker))

            broker.once('error', function (err) {
              t.equal('Throws error', err.message, 'throws error')
            })
          })
          .catch(err => t.error(err, 'no error'))
      })
  })
})

test('handle will publish error 2', function (t) {
  t.plan(1)

  const will = {
    topic: 'mywill',
    payload: Buffer.from('last will'),
    qos: 0,
    retain: true
  }

  memorySetup({ id: 'broker1' }).then(persistence => {
    persistence.putWill({ id: 'myClientId42' }, will)
      .then(() => {
        const opts = {
          persistence,
          heartbeatInterval: 10
        }

        persistence.storeRetained = async function (packet) {
          throw new Error('Throws error')
        }

        Aedes.createBroker(opts).then((broker) => {
          t.teardown(broker.close.bind(broker))

          broker.once('error', function (err) {
            t.equal('Throws error', err.message, 'throws error')
          })
        })
      })
  })
})
