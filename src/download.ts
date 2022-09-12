import fs from 'fs'
import cliProgress from 'cli-progress'
import path from 'path'
import got from 'got'
import prettyBytes from 'pretty-bytes'
import { pipeline } from 'stream/promises'
import { red, green } from 'colorette'
import { delUnfinishedFiles, checkFileExist } from './utils'
import { SongInfo } from './types'

const barList: cliProgress.SingleBar[] = []
const songNameMap = new Map<string, number>()
const unfinishedPathSet = new Set<string>()

const multiBar = new cliProgress.MultiBar({
  format: '[\u001b[32m{bar}\u001b[0m] | {file} | {value}/{total}',
  hideCursor: true,
  barCompleteChar: '#',
  barIncompleteChar: '#',
  barGlue: '\u001b[33m',
  barsize: 30,
  stopOnComplete: true,
  noTTYOutput: true,
  forceRedraw: true,
  formatValue(value, _, type) {
    if (type === 'total' || type === 'value') {
      return prettyBytes(Number(value))
    }
    return String(value)
  },
})

const downloadSong = (song: SongInfo, index: number) => {
  let { songName, songDownloadUrl, lyricDownloadUrl, songSize, options } = song
  const { lyric: withLyric = false, path: targetDir = process.cwd(), wangyi, migu, kuwo } = options
  return new Promise<void>((resolve, reject) => {
    // 防止因歌曲名重名导致下载时被覆盖
    if (songNameMap.has(songName)) {
      songNameMap.set(songName, Number(songNameMap.get(songName)) + 1)
      const [name, extension] = songName.split('.')
      const newName = `${name}(${songNameMap.get(songName)})`
      songName = `${newName}.${extension}`
    } else {
      songNameMap.set(songName, 0)
    }
    const songPath = path.join(targetDir, songName)
    const lrcName = `${songName.split('.')[0]}.lrc`
    const lrcPath = path.join(targetDir, lrcName)
    checkFileExist(songPath, songName)
    barList.push(multiBar.create(songSize, 0, { file: songName }))

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir)
    }

    const fileReadStream = got.stream(songDownloadUrl)

    const onError = (err: any) => {
      delUnfinishedFiles(targetDir, unfinishedPathSet.values())
      console.error(red(`\n${songName}下载失败，报错信息：${err}`))
      reject(err)
      process.exit(1)
    }

    fileReadStream.on('response', async () => {
      // 是否下载歌词
      if (withLyric && migu) {
        try {
          await pipeline(got.stream(lyricDownloadUrl), fs.createWriteStream(lrcPath))
        } catch (err) {
          onError(err)
        }
      }
      if (withLyric && kuwo) {
        try {
          const {
            data: { lrclist },
          } = await got(lyricDownloadUrl).json()
          let lyric = ''
          for (const lrc of lrclist) {
            lyric += `[${lrc.time}] ${lrc.lineLyric}\n`
          }
          const lrcFile = fs.createWriteStream(lrcPath)
          lrcFile.write(lyric)
        } catch (err) {
          onError(err)
        }
      }
      if (withLyric && wangyi) {
        try {
          const {
            lrc: { lyric },
          } = await got(lyricDownloadUrl).json()
          const lrcFile = fs.createWriteStream(lrcPath)
          if (lyric) {
            lrcFile.write(lyric)
          } else {
            lrcFile.write(`[00:00.00]${songName.split('.')[0]}`)
          }
        } catch (err) {
          onError(err)
        }
      }

      // 防止`onError`被调用两次
      fileReadStream.off('error', onError)

      try {
        unfinishedPathSet.add(songPath)
        await pipeline(fileReadStream, fs.createWriteStream(songPath))
        unfinishedPathSet.delete(songPath)
        resolve()
      } catch (err) {
        onError(err)
      }
    })

    fileReadStream.on('downloadProgress', ({ transferred }) => {
      barList[index].update(transferred)
    })

    fileReadStream.once('error', onError)
  })
}

const download = async (songs: SongInfo[]) => {
  if (!songs.length) {
    console.error(red('请选择歌曲'))
    process.exit(1)
  }
  const { path: targetDir = process.cwd() } = songs[0].options
  console.log(green('下载开始...'))
  multiBar.on('stop', () => {
    if (!unfinishedPathSet.size) {
      console.log(green('下载完成'))
      process.exit(0)
    }
  })
  // 多种信号事件触发执行清理操作
  ;[
    'exit',
    'SIGINT',
    'SIGHUP',
    'SIGBREAK',
    'SIGTERM',
    'unhandledRejection',
    'uncaughtException',
  ].forEach((eventType) => {
    process.on(eventType, () => {
      delUnfinishedFiles(targetDir, unfinishedPathSet.values())
      process.exit()
    })
  })
  await Promise.all(songs.map(async (song, index) => await downloadSong(song, index)))
}
export default download
