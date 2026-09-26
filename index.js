module.exports = (homebridge) => {
  const { HomeKitBleMatterPlatform, PLUGIN_IDENTIFIER, PLATFORM_NAME } =
    require("./lib/platform")(homebridge);
  homebridge.registerPlatform(
    PLUGIN_IDENTIFIER,
    PLATFORM_NAME,
    HomeKitBleMatterPlatform,
  );
};
