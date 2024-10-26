const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

let mainWindow;
let db;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(app.getPath('userData'), 'vocabulary.sqlite');
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error opening database:', err);
        reject(err);
      } else {
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='vocabulary'", (err, row) => {
          if (err) {
            console.error('Error checking if table exists:', err);
            reject(err);
          } else if (!row) {
            // Table doesn't exist, create it
            db.run(`CREATE TABLE IF NOT EXISTS vocabulary (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              word TEXT UNIQUE,
              created_at INTEGER,
              lookup_count INTEGER DEFAULT 1,
              is_favorite INTEGER DEFAULT 0
            )`, (err) => {
              if (err) {
                console.error('Error creating table:', err);
                reject(err);
              } else {
                console.log('Database table created');
                resolve();
              }
            });
          } else {
            console.log('Database table already exists');
            resolve();
          }
        });
      }
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  initDatabase().then(() => {
    console.log('Database initialized');
  }).catch(err => {
    console.error('Failed to initialize database:', err);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function executeAppleScript(script) {
  return new Promise((resolve, reject) => {
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error(`AppleScript execution error: ${error}`);
        reject(error);
      } else if (stderr) {
        console.error(`AppleScript stderr: ${stderr}`);
        reject(new Error(stderr));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function generateAppleScript(word) {
  return `
    tell application "Arc"
      activate
      delay 1
      tell application "System Events"
        keystroke "1" using command down
        delay 0.2

        repeat with i from 1 to 3
          keystroke (i as string) using {control down, shift down}
          delay 0.5
          keystroke "u" using {control down, shift down}
          delay 2
          keystroke "r" using command down
          delay 2
          keystroke "${word}"
          key code 36
          delay 0.2
        end repeat
      end tell
    end tell
    return "Success"
  `;
}

async function lookupWordInArc(word) {
  const appleScript = generateAppleScript(word);
  try {
    const result = await executeAppleScript(appleScript);
    console.log(`Operation result: ${result}`);
    return result;
  } catch (error) {
    console.error('Error executing AppleScript:', error);
    throw error;
  }
}

function addOrUpdateWord(word) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000); // 使用 UNIX 时间戳
    db.run(`INSERT INTO vocabulary (word, created_at, lookup_count, is_favorite) 
            VALUES (?, ?, 1, 0)
            ON CONFLICT(word) DO UPDATE SET 
            lookup_count = lookup_count + 1,
            created_at = CASE WHEN created_at IS NULL THEN ? ELSE created_at END`,
    [word, now, now], function(err) {
      if (err) {
        console.error('Error in addOrUpdateWord:', err);
        reject(err);
      } else {
        resolve(this.changes);
      }
    });
  });
}

function getVocabulary(page, itemsPerPage) {
  return new Promise((resolve, reject) => {
    const offset = (page - 1) * itemsPerPage;
    db.all(`SELECT word, created_at, lookup_count, is_favorite FROM vocabulary 
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?`, 
            [itemsPerPage, offset], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        db.get(`SELECT COUNT(*) as total FROM vocabulary`, (err, countResult) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              words: rows.map(row => ({
                ...row,
                lookup_count: Number(row.lookup_count),
                is_favorite: Boolean(row.is_favorite)
              })),
              total: Number(countResult.total)
            });
          }
        });
      }
    });
  });
}

function removeWord(word) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM vocabulary WHERE word = ?`, [word], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes);
      }
    });
  });
}

function searchVocabulary(searchTerm, page, itemsPerPage, sortOption, showFavorites) {
  return new Promise((resolve, reject) => {
    const offset = (page - 1) * itemsPerPage;
    let query, params;
    let orderBy;

    switch (sortOption) {
      case 'created_desc':
        orderBy = 'created_at DESC';
        break;
      case 'created_asc':
        orderBy = 'created_at ASC';
        break;
      case 'alpha_asc':
        orderBy = 'word ASC';
        break;
      case 'alpha_desc':
        orderBy = 'word DESC';
        break;
      case 'favorites':
        orderBy = 'created_at DESC';
        break;
      default:
        orderBy = 'created_at DESC';
    }
    
    let whereClause = '';
    if (searchTerm.trim() !== '') {
      whereClause = 'WHERE word LIKE ?';
      params = [`%${searchTerm}%`];
    } else {
      params = [];
    }

    if (showFavorites) {
      whereClause = whereClause ? `${whereClause} AND is_favorite = 1` : 'WHERE is_favorite = 1';
    }

    query = `SELECT word, created_at, lookup_count, is_favorite FROM vocabulary 
             ${whereClause}
             ORDER BY ${orderBy}
             LIMIT ? OFFSET ?`;
    
    params.push(itemsPerPage, offset);

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        let countQuery = `SELECT COUNT(*) as total FROM vocabulary ${whereClause}`;
        let countParams = params.slice(0, -2);  // Remove LIMIT and OFFSET

        db.get(countQuery, countParams, (err, countResult) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              words: rows.map(row => ({
                ...row,
                lookup_count: Number(row.lookup_count),
                is_favorite: Boolean(row.is_favorite),
                created_at: Number(row.created_at) * 1000 // 转换为毫秒
              })),
              total: Number(countResult.total)
            });
          }
        });
      }
    });
  });
}

function getAllWords() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT word FROM vocabulary ORDER BY word ASC`, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows.map(row => row.word));
      }
    });
  });
}

function resetDatabase() {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(app.getPath('userData'), 'vocabulary.sqlite');
    
    // 关闭现有的数据库连接
    if (db) {
      db.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
          reject(err);
          return;
        }
        
        // 删除数据库文件
        fs.unlink(dbPath, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.error('Error deleting database file:', err);
            reject(err);
            return;
          }
          
          // 重新初始化数据库
          initDatabase()
            .then(() => resolve())
            .catch((err) => reject(err));
        });
      });
    } else {
      // 如果数据库连接不存在，直接重新初始化
      initDatabase()
        .then(() => resolve())
        .catch((err) => reject(err));
    }
  });
}

// 添加导出数据库功能
function exportDatabase() {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(app.getPath('userData'), 'vocabulary.sqlite');
    const backupPath = path.join(app.getPath('downloads'), 'vocabulary_backup.sqlite');

    fs.copyFile(dbPath, backupPath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(backupPath);
      }
    });
  });
}

// 添加导入数据库功能
function importDatabase(filePath) {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(app.getPath('userData'), 'vocabulary.sqlite');

    // 关闭现有的数据库连接
    if (db) {
      db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        
        // 复制导入的文件到应用数据目录
        fs.copyFile(filePath, dbPath, (err) => {
          if (err) {
            reject(err);
          } else {
            // 重新初始化数据库连接
            initDatabase()
              .then(() => resolve())
              .catch((err) => reject(err));
          }
        });
      });
    } else {
      // 如果数据库连接不存在，直接复制文件并初始化
      fs.copyFile(filePath, dbPath, (err) => {
        if (err) {
          reject(err);
        } else {
          initDatabase()
            .then(() => resolve())
            .catch((err) => reject(err));
        }
      });
    }
  });
}

ipcMain.on('lookup-word', async (event, word, openArc, itemsPerPage) => {
  try {
    // 首先将单词添加到数据库
    await addOrUpdateWord(word);
    console.log(`Word "${word}" added/updated in the database`);

    let result = "Word added to database";
    if (openArc) {
      // 如果选择打开 ARC，则执行 lookup 操作
      result = await lookupWordInArc(word);
      console.log(`Lookup result for "${word}": ${result}`);
    }

    // 获取更新后的词汇列表，使用用户选择的每页数量
    const vocabulary = await getVocabulary(1, itemsPerPage);

    // 发送结果回渲染进程
    event.reply('lookup-result', { 
      success: true, 
      message: result, 
      vocabulary,
      openedArc: openArc
    });
  } catch (error) {
    console.error(`Error during lookup of "${word}":`, error);
    event.reply('lookup-result', { success: false, message: error.message });
  }
});

ipcMain.on('get-vocabulary', async (event, page, itemsPerPage) => {
  try {
    const result = await getVocabulary(page, itemsPerPage);
    event.reply('vocabulary', result);
  } catch (error) {
    event.reply('vocabulary-error', error.message);
  }
});

ipcMain.on('remove-word', async (event, word) => {
  try {
    await removeWord(word);
    event.reply('word-removed', { success: true, word: word });
  } catch (error) {
    console.error(`Error removing "${word}" from database:`, error);
    event.reply('word-removed', { success: false, message: error.message });
  }
});

ipcMain.on('search-vocabulary', async (event, searchTerm, page, itemsPerPage, sortOption, showFavorites) => {
  try {
    const result = await searchVocabulary(searchTerm, page, itemsPerPage, sortOption, showFavorites);
    event.reply('search-result', result);
  } catch (error) {
    console.error('Error searching vocabulary:', error);
    event.reply('search-error', error.message);
  }
});

ipcMain.on('get-all-words', async (event) => {
  try {
    const words = await getAllWords();
    event.reply('all-words', words);
  } catch (error) {
    console.error('Error getting all words:', error);
  }
});

// 添加切换收藏状态的函数
function toggleFavorite(word) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE vocabulary SET is_favorite = 1 - is_favorite WHERE word = ?`,
    [word], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes);
      }
    });
  });
}

// 添加 IPC 处理程序来处理收藏换
ipcMain.on('toggle-favorite', async (event, word) => {
  try {
    await toggleFavorite(word);

    const result = await getVocabulary(1, itemsPerPage); // 假设我们总是返回第一页

    event.reply('vocabulary', result);
  } catch (error) {
    event.reply('toggle-favorite-error', error.message);
  }
});

// 添加新的 IPC 监听器来处理重置数据库的请求
ipcMain.on('reset-database', async (event) => {
  try {
    await resetDatabase();
    event.reply('database-reset', { success: true });
  } catch (error) {
    console.error('Error resetting database:', error);
    event.reply('database-reset', { success: false, message: error.message });
  }
});

ipcMain.on('add-word', async (event, word) => {
  try {
    await addOrUpdateWord(word);
    console.log(`Word "${word}" added to the database`);

    // 获取更新后的词汇列表
    const vocabulary = await getVocabulary(1, 10000); // 假设我们想显示所有单词

    // 发送结果回渲染进程
    event.reply('word-added', { 
      success: true, 
      word: word,
      vocabulary: vocabulary
    });
  } catch (error) {
    console.error(`Error adding "${word}" to database:`, error);
    event.reply('word-added', { success: false, message: error.message });
  }
});

// 添加新的 IPC 监听器
ipcMain.on('export-database', async (event) => {
  try {
    const backupPath = await exportDatabase();
    event.reply('database-exported', { success: true, path: backupPath });
  } catch (error) {
    console.error('Error exporting database:', error);
    event.reply('database-exported', { success: false, message: error.message });
  }
});

ipcMain.on('import-database', async (event) => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['sqlite'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      await importDatabase(result.filePaths[0]);
      event.reply('database-imported', { success: true });
    } else {
      event.reply('database-imported', { success: false, message: 'Import cancelled' });
    }
  } catch (error) {
    console.error('Error importing database:', error);
    event.reply('database-imported', { success: false, message: error.message });
  }
});
