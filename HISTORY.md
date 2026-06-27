Generate init pages. Initialize frontend with vue, backend with express.
files:
- client\
- - src\
- - - App.vue
- - - main.js
- - - styles.css
- - index.html
- - package.json
- - vite.config.js
- server\
- - src\
- - - index.js
- - package.json
- package.json
- package-lock.json

Add account system. Initialize SQLite.
files:
- server\
- - data\
- - - (sqlitefiles)
- - src\
- - - auth\
- - - - middleware.js
- - - - password.js
- - - - routes.js
- - - db\
- - - - index.js
- - - - migrate.js
- - - users\
- - - - queries.js
- - - env.js

Sanity check. 
When logging in, session regenerates.
SESSION_SECRET is checked when production mode.
TODO: CSRF
