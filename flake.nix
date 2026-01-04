{
  description = "MarioCrade";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      nixpkgs,
      self,
      ...
    }:
    let
      forAllSystems =
        function:
        nixpkgs.lib.genAttrs [
          "x86_64-linux"
          "aarch64-linux"
          "x86_64-darwin"
          "aarch64-darwin"
        ] (system: function nixpkgs.legacyPackages.${system});

      dbName = "mk_reset";
      dbUserName = "mk_reset";
      dbPassword = "password";

      configure = ''
        psql -h localhost -p 5432 -U $USER -d postgres -c "CREATE ROLE ${dbUserName} WITH LOGIN CREATEDB REPLICATION;"
        psql -h localhost -p 5432 -U $USER -d postgres -c "CREATE USER ${dbUserName} WITH PASSWORD '${dbPassword}';"
        psql -h localhost -p 5432 -U $USER -d postgres -c "CREATE DATABASE ${dbName} WITH OWNER ${dbUserName};";
      '';
    in
    {
      nixosModules = {
        default =
          {
            lib,
            pkgs,
            config,
            ...
          }:
          (import ./nix/module.nix {
            inherit
              lib
              pkgs
              config
              self
              ;
          })
          // (import ./nix/options.nix { inherit lib; });
      };

      packages = forAllSystems (pkgs: {
        mkReset = pkgs.callPackage ./nix/package.nix { };
        deps = pkgs.callPackage ./nix/dependencies.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.mkReset;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          buildInputs = [
            self.packages.${pkgs.stdenv.hostPlatform.system}.deps
            pkgs.postgresql
          ];

          env = {
            POSTGRES_DB = dbName;
            POSTGRES_USER = dbUserName;
            POSTGRES_PASSWORD = dbPassword;
            POSTGRES_HOST = "localhost";
            POSTGRES_PORT = 5432;
            ADMIN_TOKEN = "secret";
            ADMIN_PASSWORD_HASH = "$2a$12$lLsQonpUM1UrTfjJY42eTeFvZFKXIGtKaqzCkteLcqRGiWTygzy9e";
            SECRET_KEY = "secret";
            BACKEND_URL = "http://localhost:8080";
          };

          shellHook = ''
            alias pginit='pg_ctl -D ${self}/data init;';
            alias pgstart='pg_ctl -D ${self}/data -l pglogfile start -o "-k ${self}/"; ';
            alias pgconfigure=${pkgs.writeScript "pgconfigure" configure};

            echo "pginit init database"
            echo "pgstart start database"
            echo "pgconfigure create db and user"

            echo "populate db"
            echo "psql -h localhost -U mk_reset -d mk_reset -W -f ./backEnd/schema.sql 
            echo "psql -h localhost -U mk_reset -d mk_reset -W -f ./backEnd/seed.sql 

            echo Now developping Mario Krade!


            alias backend_start='cd ${self}/backEnd; python -c "from backend import sync_sequences, recalculate_tiers; sync_sequences(); recalculate_tiers()" && gunicorn -w 4 -b 0.0.0.0:8080 backend:app;'
            alias frontend_start='cd ${self}/frontEnd; gunicorn -w 4 -b 0.0.0.0:5000 frontend:app'

            echo "backend_start : start backend"
            echo "frontend_start: start frontend"

          '';
        };
      });
    };
}
