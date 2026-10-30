// 网易云搜索经常不返回封面，这里批量调用云函数补全缺失封面
const MAX_MIDS_PER_REQUEST = 30

function hasUsableCover(song) {
  return Boolean(song && song.pic && /^https?:\/\//i.test(String(song.pic)))
}

function collectMissingMids(songs) {
  const mids = []
  songs.forEach((song) => {
    if (!song || song.source !== 'netease' || hasUsableCover(song)) {
      return
    }
    const mid = String(song.mid || '')
    if (/^\d+$/.test(mid) && !mids.includes(mid)) {
      mids.push(mid)
    }
  })
  return mids
}

function applyCovers(songs, covers) {
  songs.forEach((song) => {
    if (!song || song.source !== 'netease' || hasUsableCover(song)) {
      return
    }
    const pic = covers[String(song.mid)]
    if (pic) {
      song.pic = pic
      song.cover = pic
    }
  })
}

function fillSongCovers(songs) {
  const app = getApp()
  const list = Array.isArray(songs) ? songs : []
  const mids = collectMissingMids(list)
  if (!mids.length) {
    return Promise.resolve(list)
  }
  const batches = []
  for (let index = 0; index < mids.length; index += MAX_MIDS_PER_REQUEST) {
    batches.push(mids.slice(index, index + MAX_MIDS_PER_REQUEST))
  }
  return new Promise((resolve) => {
    const run = (batchIndex) => {
      if (batchIndex >= batches.length) {
        resolve(list)
        return
      }
      app.request({
        url: 'song/getCovers',
        data: { mids: batches[batchIndex] },
        success: (res) => {
          applyCovers(list, res.data || {})
          run(batchIndex + 1)
        },
        login: () => resolve(list),
        error: () => {
          resolve(list)
          return true
        },
        fail: () => resolve(list)
      })
    }
    run(0)
  })
}

module.exports = {
  fillSongCovers
}
