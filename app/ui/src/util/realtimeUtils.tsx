import {Gauge, Plot} from '@antv/g2plot'
import React, {useCallback, useEffect, useRef, useState} from 'react'
import {simplifyForNormalizedData} from './simplyfi'

export type MinAndMax = {min: number; max: number}
export const getMinAndMax = (arr: number[]): MinAndMax => {
  let min = Infinity
  let max = -Infinity
  for (const i of arr) {
    if (min > i) min = i
    if (max < i) max = i
  }
  return {min, max}
}

const normalize = (arr: number[], minAndMax: MinAndMax, inverse = false) => {
  const {max, min} = minAndMax
  const dist = max - min
  if (!inverse) {
    return arr.map((x) => (x - min) / dist)
  } else {
    return arr.map((x) => x * dist + min)
  }
}

/** simplify that has data normalization implemented */
const simplify = (xs: number[], ys: number[], epsilon: number) => {
  if (xs.length < 2) return [xs, ys] as const

  const xMinAndMax = getMinAndMax(xs)
  const yMinAndMax = getMinAndMax(ys)

  const [
    xsSimplifiedNormalized,
    ysSimplifiedNormalized,
  ] = simplifyForNormalizedData(
    normalize(xs, xMinAndMax),
    normalize(ys, yMinAndMax),
    epsilon
  )

  const xsSimplified = normalize(xsSimplifiedNormalized, xMinAndMax, true)
  const ysSimplified = normalize(ysSimplifiedNormalized, yMinAndMax, true)

  return [xsSimplified, ysSimplified] as const
}

export type DiagramEntryPoint = {
  value: number
  time: number
  key: string
}

export const useWebSocket = (
  callback: (ws: WebSocket) => void,
  url: string
) => {
  const wsRef = useRef<WebSocket>()

  const startListening = useCallback(() => {
    console.log('starting WebSocket')
    wsRef.current = new WebSocket(url)
    callback(wsRef.current)
  }, [callback, url])

  useEffect(() => {
    startListening()
    return () => wsRef.current?.close?.()
  }, [startListening])

  useEffect(() => {
    // reconnect a broken WS connection
    const checker = setInterval(() => {
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.CLOSING ||
          wsRef.current.readyState === WebSocket.CLOSED)
      ) {
        startListening()
      }
    }, 2000)
    return () => clearInterval(checker)
  }, [startListening])
}

const useRafOnce = (callback: () => void, deps: any[] = []) => {
  const calledRef = useRef(false)

  const fnc = useCallback(callback, deps)

  return useCallback(() => {
    if (calledRef.current) return
    calledRef.current = true
    requestAnimationFrame(() => {
      calledRef.current = false
      fnc()
    })
  }, [fnc])
}

const formatter = (v: string) => new Date(+v).toLocaleTimeString()

const g2PlotDefaults = {
  data: [],
  percent: 0,
  xField: 'time',
  yField: 'value',
  seriesField: 'key',
  animation: false,
  xAxis: {
    type: 'time',
    mask: 'HH:MM:ss',
    nice: false,
    tickInterval: 4,
  },
}

export const useLastDiagramEntryPointGetter = (): {
  (points: DiagramEntryPoint[]): DiagramEntryPoint | undefined
  reset: () => void
} => {
  const lastPointRef = useRef<DiagramEntryPoint>()

  const getLastPoint = (points: DiagramEntryPoint[]) => {
    if (!points.length) return lastPointRef.current
    if (!lastPointRef.current) lastPointRef.current = points[0]

    for (const p of points) {
      if (lastPointRef.current.time < p.time) {
        lastPointRef.current = p
      }
    }

    return lastPointRef.current
  }

  getLastPoint.reset = () => {
    lastPointRef.current = undefined
  }

  return getLastPoint
}

const asArray = <T,>(value: T[] | T): T[] =>
  Array.isArray(value) ? value : [value]

const applyRetention = (arr: DiagramEntryPoint[], retentionTimeMs: number) => {
  if (retentionTimeMs === Infinity || retentionTimeMs === 0) return
  if (retentionTimeMs < 0)
    throw new Error(`retention time has to be bigger than zero`)

  const now = Date.now()
  const cutTime = now - retentionTimeMs

  for (let i = arr.length; i--; ) {
    if (arr[i].time < cutTime) {
      arr.splice(i, 1)
    }
  }
}

export type PlotConstructor = new (...args: any[]) => Plot<any>
export type G2PlotOptionsNoData<T> = Omit<
  ConstructorParameters<new (...args: any[]) => Plot<T>>[1],
  'data' | 'percent'
>
export type G2PlotUpdater<PlotType> = (
  newData:
    | undefined
    | DiagramEntryPoint
    | DiagramEntryPoint[]
    | (PlotType extends Gauge ? number : never)
) => void

export const useG2Plot = (
  ctor: PlotConstructor,
  opts?: Omit<ConstructorParameters<PlotConstructor>[1], 'data' | 'percent'>,
  retentionTimeMs = Infinity
) => {
  type PlotType = InstanceType<PlotConstructor>

  const plotRef = useRef<PlotType>()
  const dataRef = useRef<DiagramEntryPoint[] | number | undefined>()
  const getLastPoint = useLastDiagramEntryPointGetter()

  const elementRef = useRef<HTMLDivElement>(undefined!)
  const element = <div ref={elementRef} />

  const retentionTimeRef = useRef(retentionTimeMs)
  const retentionUsed = () =>
    retentionTimeRef.current !== Infinity && retentionTimeRef.current > 0
  const getLatestDataTime = () => {
    const data = dataRef.current

    if (data === undefined) return undefined
    if (typeof data === 'number') return getLastPoint([])?.time
    if (!data.length) return undefined
    return getMinAndMax(data.map((x) => x.time)).max
  }

  const getPlotOptions = () => {
    const data = dataRef.current
    const now = Date.now()

    return {
      ...g2PlotDefaults,
      ...opts,
      xAxis: {
        ...g2PlotDefaults?.xAxis,
        ...(retentionUsed()
          ? {
              min: now - retentionTimeRef.current,
              max: getLatestDataTime(),
              tickMethod: 'wilkinson-extended',
            }
          : {min: undefined, max: undefined}),
        ...opts?.xAxis,
      },
      ...(typeof data === 'number' ? {percent: data} : {}),
      ...(Array.isArray(data) ? {data} : {}),
    }
  }

  useEffect(() => {
    retentionTimeRef.current = retentionTimeMs
  }, [retentionTimeMs])

  useEffect(() => {
    if (!elementRef.current) return
    plotRef.current = new ctor(elementRef.current, getPlotOptions())
    plotRef.current!.render()
  }, [])

  const redraw = useRafOnce(() => {
    plotRef.current?.update?.(getPlotOptions())
  }, [opts])
  useEffect(redraw, [redraw])

  const invalidate = useRafOnce(() => {
    // todo: don't redraw when window not visible
    const data = dataRef.current

    if (data === undefined) {
      plotRef.current?.changeData?.([])
    } else if (typeof data === 'number') plotRef.current?.changeData?.(data)
    else plotRef.current?.changeData?.(data)
  })

  const update: G2PlotUpdater<PlotType> = (newData) => {
    if (newData === undefined || typeof newData === 'number') {
      getLastPoint.reset()
      dataRef.current = newData
    } else if (ctor === Gauge)
      dataRef.current = getLastPoint(asArray(newData))?.value
    else if (Array.isArray(dataRef.current))
      pushBigArray(dataRef.current, asArray(newData))
    else dataRef.current = asArray(newData)

    if (Array.isArray(dataRef.current))
      applyRetention(dataRef.current, retentionTimeRef.current)

    if (retentionUsed()) redraw()
    else invalidate()
  }

  const plotObjRef = useRef({element, update} as const)

  return plotObjRef.current
}

type G2PlotParams = {
  type: PlotConstructor
  simplify?: boolean
  options?: G2PlotOptionsNoData<any>
  onUpdaterChange: (updater: G2PlotUpdater<Plot<any>>) => void
  retentionTimeMs?: number
}

export const G2Plot = (params: G2PlotParams) => {
  const {element, update} = useG2Plot(
    params.type,
    params.options,
    params.retentionTimeMs
  )
  useEffect(() => {
    params.onUpdaterChange(update)
  }, [update])

  return <>{element}</>
}

/**
 * using spred operator (Array.push(...items))
 * function can exceed callback for big arrays.
 * Use this method instead
 */
export const pushBigArray = <T,>(self: T[], arr2: T[]) => {
  const arr2len = arr2.length
  const newLen = self.length + arr2len
  self.length = newLen
  let i = newLen
  for (let j = arr2len; j--; ) {
    i--
    self[i] = arr2[j]
  }
}