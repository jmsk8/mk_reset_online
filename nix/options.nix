{ lib, config,... }:
with lib;
{
  options = {
    services.mkReset = {
      enable = mkEnableOption "Mk Reset (classements)";

      user = lib.mkOption {
        type = lib.types.str;
        description = "service user's username";
        default = "mk_reset";
      };

      frontend = {
        port = lib.mkOption {
          type = lib.types.str;
          description = "Port for frontend app";
          default = "8654";
        };
      };

      backend = {
        port = lib.mkOption {
          type = lib.types.str;
          description = "Port for backend app";
          default = "8653";
        };
      };

      database = {
        name = lib.mkOption {
          type = lib.types.str;
          description = "DB name";
          default = config.services.mkReset.user;
        };

        user = lib.mkOption {
          type = lib.types.str;
          description = "DB user's username";
          default = "mk_reset";
        };
      };

      envFile = mkOption {
        description = "Environment variables for the app";
        type = lib.types.path;
        default = null;
      };
    };
  };
}
