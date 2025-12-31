{
  config,
  lib,
  self,
  pkgs,
  ...
}:
let
  cfg = config.services.mkReset;

  user = "mk_reset";

  pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.mkReset;
  depsPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.deps;

  startBackend = pkgs.writeShellApplication {
    name = "start_mario_crade_backend.sh";

    runtimeInputs = [
      depsPkg
    ];

    text = ''
      cd ${pkg}/backEnd;

      set -a; 
      # shellcheck disable=SC1091
      source ${cfg.envFile}; 
      set +a

      python3 -c 'from backend import sync_sequences, recalculate_tiers; sync_sequences(); recalculate_tiers();';

      gunicorn -w 4 -b 0.0.0.0:${cfg.backend.port} backend:app;
    '';
  };

  startFrontend = pkgs.writeShellApplication {
    name = "start_mario_crade_frontend.sh";

    runtimeInputs = [
      depsPkg
    ];

    text = ''
      cd ${pkg}/frontEnd;

      set -a; 
      # shellcheck disable=SC1091
      source ${cfg.envFile}; 
      set +a

      echo "ENVIRONMENT"
      env

      gunicorn -w 4 -b 0.0.0.0:${cfg.frontend.port} frontend:app;
    '';
  };
in
{
  config = lib.mkIf cfg.enable {
    users.users.${user} = {
      home = "/home/${user}";
      group = user;
      isSystemUser = true;
    };

    users.groups.${user}.members = [ user ];

    systemd.services = {
      mario-crade-frontend = {
        enable = true;
        after = [
          "network.target"
          "mario-crade-backend.service"
        ];
        wantedBy = [ "multi-user.target" ];
        description = "Mario Krade service";
        serviceConfig = {
          Type = "simple";
          ExecStart = "${startFrontend}/bin/start_mario_crade_frontend.sh";
          User = user;
        };
      };
      mario-crade-backend = {
        enable = true;
        after = [ "network.target" ];
        wantedBy = [ "multi-user.target" ];
        description = "Mario Krade service";
        serviceConfig = {
          User = user;
          Type = "simple";
          ExecStart = "${startBackend}/bin/start_mario_crade_backend.sh";
        };
      };
    };

    services = {
      postgresql = {
        enable = true;
        ensureDatabases = [ cfg.database.name ];
        ensureUsers = [
          {
            name = cfg.database.user;
            ensureDBOwnership = true;
          }
        ];
      };
    };
  };
}
