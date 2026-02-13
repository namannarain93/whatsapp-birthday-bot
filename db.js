// Re-export everything from the refactored src/db modules for backward compatibility.
// New code should import directly from 'src/db' or the specific repository file.
module.exports = require('./src/db');
