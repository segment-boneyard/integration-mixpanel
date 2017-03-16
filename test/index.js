
var Test = require('segmentio-integration-tester');
var helpers = require('./helpers');
var assert = require('assert');
var time = require('unix-time');
var Mixpanel = require('..');
var uuid = require('uuid');

describe('Mixpanel', function(){
  var mixpanel;
  var settings;
  var test;

  beforeEach(function(){
    settings = {
      apiKey: 'c31daa4f214e00452a9658cadc5ef6de',
      secret: '2692184e7c7a4d9a005b12cf4b9fb22c',
      token: '50912cd33fd82225ab5ae1c563bd5a7e',
      people: true,
      setAllTraitsByDefault: true
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

    it('should be invalid for messages with a timestamp older than five years', function(){
      test.invalid({
        type: 'track',
        timestamp: new Date('5/10/2010')
      }, settings);
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
        .end(function(err, res) {
          assert.equal(err.status, 400);
          done();
        });
    });


    it('should send identify with context correctly', function(done){
      var json = updateFixtureTimestamp(test.fixture('identify-context'));

      //Test if the context settings have come through properly.
      test
        .set(settings)
        .identify(json.input)
        .query({ ip: 0, verbose: 1 })
        .query('data', json.output, decode)
        .expects(200)
        //What does the query need to do and check here?
        .end(done);
    });

    it('should filter to peopleProperties setting when setAllTraitsByDefault is false', function(done){
      var identify = updateFixtureTimestamp(test.fixture('identify-filter-properties'));
      test
        .set({ setAllTraitsByDefault: false })
        .set({ peopleProperties: [ '$first_name', 'met', '$created', '$email', 'id' ] })
        .identify(identify.input)
        .query({ ip: 0, verbose: 1 })
        .query('data', identify.output, decode)
        .requests(1)
        .expects(200, done);
    })
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
        .requests(1)
        .expects(200, done);
    });

    it('should have proper error status code', function(done){
      var json = test.fixture('track-basic');
      json.input.userId = uuid();
      // sending timestamp far in the future will trigger an error response from their API
      json.input.timestamp = new Date('2123-09-16');
    
      test
        .set(settings)
        .set({ people: false })
        .track(json.input)
        .end(function(err, res){
          console.log(res);
          assert.equal(err.status, 400);
          done();
        });
    });

    it('should send revenue correctly', function(done){
      var json = test.fixture('track-revenue');
      var timestamp = json.input.timestamp = new Date();
      json.output.$append.$transactions.$time = timestamp.toISOString().slice(0,19);

      var suite = test
        .requests(2) // total number of requests
        .set(settings)
        .set({ people: false })
        .track(json.input);

      suite
        .request(1) // second request
        .query({ verbose: '1' })
        .query({ ip: '0' })
        .query('data', json.output, decode)
        .expects(200, done);
    });

    it('should not send last seen with revenue if active flag is false', function(done){
      var json = test.fixture('track-ignore-time-with-revenue');
      var timestamp = json.input.timestamp = new Date();
      json.output.$append.$transactions.$time = timestamp.toISOString().slice(0,19);

      var suite = test
        .requests(2) // total number of requests
        .set(settings)
        .set({ people: false })
        .track(json.input);

      suite
        .request(1) // second request
        .query({ verbose: '1' })
        .query({ ip: '0' })
        .query('data', json.output, decode)
        .expects(200, done);
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
        .requests(1)
        .expects(200, done);
    });

    it('should send track with only browser context correctly', function(done){
      var json = test.fixture('track-context-browser');
      test
        .set(settings)
        .set({ people: false })
        .track(json.input)
        .query({ api_key: settings.apiKey })
        .query({ verbose: '1' })
        .query('data', json.output, decode)
        .requests(1)
        .expects(200, done);
    });

    it('should send track with referrer correctly', function(done){
      var json = test.fixture('track-referrer');
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


    // TODO: why are these tests not checking output payload?
    it('should be able to track correctly', function(done){
      mixpanel.track(helpers.track(), done);
    });

    // TODO: why are these tests not checking output payload?
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
        .error('distinct_id, missing or empty', done);
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
        .expects(200, done);
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
        .expects(200, done);
    });

    it('should be able to track categorized pages with consolidated names', function(done){
      var json = test.fixture('page-categorized-consolidated');
      test
        .set(settings)
        .set(json.settings)
        .page(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .expects(200, done);
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
        .expects(200, done);
    });

    it('should be able to track named pages with the consolidated page name', function(done){
      var json = test.fixture('page-named-consolidated');
      test
        .set(settings)
        .set(json.settings)
        .page(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .expects(200, done);
    });

    it('should not send any requests for disabled pages', function(done){
      var json = test.fixture('page-named');
      test
       .set({
        trackCategorizedPages: false,
        trackNamedPages: false,
        trackAllPages: false
       })
       .page(json.input)
       .requests(0)
       .end(done);
    })
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
        .expects(200, done);
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
        .expects(200, done);
    });

    it('should be able to track categorized screens with consolidated names', function(done){
      var json = test.fixture('screen-categorized-consolidated');
      test
        .set(settings)
        .set(json.settings)
        .screen(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .expects(200, done);
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
        .expects(200, done);
    });

    it('should be able to track named screens with the consolidated screen name', function(done){
      var json = test.fixture('screen-named-consolidated');
      test
        .set(settings)
        .set(json.settings)
        .screen(json.input)
        .query('data', json.output, decode)
        .query('api_key', settings.apiKey)
        .query('verbose', '1')
        .expects(200, done);
    });

    it('should not send any requests for disabled screens', function(done){
      var json = test.fixture('screen-named');
      test
       .set({
        trackCategorizedPages: false,
        trackNamedPages: false,
        trackAllPages: false
       })
       .page(json.input)
       .requests(0)
       .end(done);
    })
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
