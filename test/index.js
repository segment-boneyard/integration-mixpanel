
var Test = require('segmentio-integration-tester');
var helpers = require('./helpers');
var assert = require('assert');
var time = require('unix-time');
var Mixpanel = require('..');

describe('Mixpanel', function(){
  var mixpanel;
  var settings;
  var test;

  beforeEach(function(){
    settings = {
      apiKey: 'c31daa4f214e00452a9658cadc5ef6de',
      secret: '2692184e7c7a4d9a005b12cf4b9fb22c',
      token: '50912cd33fd82225ab5ae1c563bd5a7e',
      people: true
    };
    mixpanel = new Mixpanel(settings);
    test = Test(mixpanel, __dirname);
  });

  it('should have correct settings', function(){
    test
      .name('Mixpanel')
      .endpoint('https://api.mixpanel.com')
      .ensure('settings.token')
      .channels(['server']);
  });

  describe('.validate()', function(){
    it('should be invalid when .token is missing', function(){
      delete settings.token;
      test.invalid({}, settings);
    });

    it('should be invalid for old "track" messages without .apiKey', function(){
      delete settings.apiKey;
      test.invalid({
        type: 'track',
        timestamp: new Date('5/10/2014')
      }, settings);
    });

    it('should be valid for new "track" messages without .apiKey', function(){
      delete settings.apiKey;
      test.valid({
        type: 'track',
        timestamp: new Date
      }, settings);
    });

    it('should be valid when all settings are given', function(){
      test.valid({}, settings);
    });
  });

  describe('.identify()', function(){
    it('should do nothing if `.people` is false', function(done){
      var msg = helpers.identify();
      mixpanel.settings.people = false;
      mixpanel.identify(msg, function(){
        assert.equal(0, arguments.length);
        done();
      });
    });

    it('should send identify correctly', function(done){
      var json = updateFixtureTimestamp(test.fixture('identify-basic'));

      test
        .set(settings)
        .identify(json.input)
        .query({ ip: 0, verbose: 1 })
        .query('data', json.output, decode)
        .expects(200)
        .end(done);
    });

    it('should be able to identify correctly', function(done){
      var msg = helpers.identify();
      mixpanel.identify(msg, done);
    });

    it('should send $set correctly when device token is provided', function(done){
      var json = updateFixtureTimestamp(test.fixture('identify-device-token-set'));

      test
        .set(settings)
        .identify(json.input)
        .request(0)
        .query({ ip: 0, verbose: 1 })
        .query('data', json.output, decode)
        .expects(200)
        .end(done)
    });

    it('should send $union correctly when device token is provided', function(done){
      var json = updateFixtureTimestamp(test.fixture('identify-device-token-union'));

      test
        .set(settings)
        .identify(json.input)
        .request(1)
        .query({ ip: 0, verbose: 1 })
        .query('data', json.output, decode)
        .expects(200)
        .end(done)
    });

    it('should error on invalid request', function(done){
      test
        .set({ apiKey: 'x' })
        .set({ secret: 'x' })
        .set({ token: 'x' })
        .identify({})
        .error('Mixpanel: $distinct_id, missing or empty', done);
    });
  });

  describe('.track()', function(){
    it('should send track correctly', function(done){
      var json = test.fixture('track-basic');
      var date = json.input.timestamp = new Date();
      json.output.properties.time = time(date);
      test
        .set(settings)
        .set({ people: false })
        .track(json.input)
        .query({ api_key: settings.apiKey })
        .query({ verbose: '1' })
        .query('data', json.output, decode)
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(1, res.length);
          assert.equal(200, res[0].status);
          done();
        });
    });

    it('should send track with context correctly', function(done){
      var json = test.fixture('track-context');
      test
        .set(settings)
        .set({ people: false })
        .track(json.input)
        .query({ api_key: settings.apiKey })
        .query({ verbose: '1' })
        .query('data', json.output, decode)
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(1, res.length);
          assert.equal(200, res[0].status);
          done();
        });
    });

    it('should be able to track correctly', function(done){
      mixpanel.track(helpers.track(), done);
    });

    it('should be able to track a bare call', function(done){
      mixpanel.track(helpers.track.bare(), done);
    });

    it('should increment', function(done){
      var track = helpers.track({ event: 'increment' });
      mixpanel.settings.increments = [track.event()];
      mixpanel.track(track, done);
    })

    it('should be able to track ill-formed traits', function(done){
      mixpanel.track(helpers.track.bare({
        context: {
          traits: 'aaa'
        }
      }), done);
    });
  });

  describe('.alias()', function(){
    it('should be able to alias properly', function(done){
      var json = test.fixture('alias-basic');
      test
        .set(settings)
        .alias(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .query('ip', '0')
        .expects(200)
        .end(done);
    });


    it('should error on invalid request', function(done){
      test
        .set({ apiKey: 'x' })
        .set({ secret: 'x' })
        .set({ token: 'x' })
        .alias({})
        .error('Mixpanel: distinct_id, missing or empty', done);
    });
  });

  describe('.page()', function(){
    it('should be able to track all pages', function(done){
      var json = test.fixture('page-all');
      test
        .set(settings)
        .set(json.settings)
        .page(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(200, res[0].status);
          done();
        });
    });

    it('should be able to track categorized pages', function(done){
      var json = test.fixture('page-categorized');
      test
        .set(settings)
        .set(json.settings)
        .page(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(200, res[0].status);
          done();
        });
    });

    it('should be able to track named pages', function(done){
      var json = test.fixture('page-named');
      test
        .set(settings)
        .set(json.settings)
        .page(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(200, res[0].status);
          done();
        });
    });
  });

  describe('.screen()', function(){
    it('should be able to track all screens', function(done){
      var json = test.fixture('screen-all');
      test
        .set(settings)
        .set(json.settings)
        .screen(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(200, res[0].status);
          done();
        });
    });

    it('should be able to track categorized screen', function(done){
      var json = test.fixture('screen-categorized');
      test
        .set(settings)
        .set(json.settings)
        .screen(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(200, res[0].status);
          done();
        });
    });

    it('should be able to track named screen', function(done){
      var json = test.fixture('screen-named');
      test
        .set(settings)
        .set(json.settings)
        .screen(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .end(function(err, res){
          if (err) return done(err);
          assert.equal(200, res[0].status);
          done();
        });
    });
  });
});

/**
 * Decode base64 and parse json
 */

function decode(data){
  var buf = new Buffer(data, 'base64');
  return JSON.parse(buf.toString());
}

/**
 * Set a fixture's timestamping to the current date.
 *
 * https://mixpanel.com/help/reference/http#storing-user-profiles, $time
 * section: Updates are stored as events in Mixpanel, which are replayed in
 * $time order. If you send an update with the same timestamp as an older
 * update, it won't show up.
 */

function updateFixtureTimestamp(fixture) {
  var date = new Date();
  fixture.input.timestamp = date.toISOString();
  fixture.output.$time = date.getTime();
  return fixture;
}
