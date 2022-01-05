import React, {
  FunctionComponent,
  useEffect,
  useState,
  useRef,
  useCallback,
} from 'react'
import {RouteComponentProps} from 'react-router-dom'
import {Button, Card, Select, Tooltip, Upload} from 'antd'
import PageContent, {Message} from './PageContent'
import {IconRefresh, IconSettings, colorLink, colorPrimary} from '../styles'
import ReactGridLayoutFixed from '../util/ReactGridLayoutFixed'

import {
  flux,
  fluxDuration,
  fluxExpression,
  InfluxDB,
} from '@influxdata/influxdb-client'
import {GaugeOptions, LineOptions, Datum} from '@antv/g2plot'
import {Table as GiraffeTable} from '@influxdata/giraffe'
import {VIRTUAL_DEVICE} from '../App'
import {DeviceInfo} from './DevicesPage'
import {DiagramEntryPoint} from '../util/realtime'
import {queryTable} from '../util/queryTable'
import {
  asArray,
  DataManager,
  ManagedG2Plot,
  ManagedMap,
  ManagedSvg,
  MinAndMax,
} from '../util/realtime'
import {DataManagerContextProvider, useWebSocket} from '../util/realtime/react'
import Markdown from '../util/Markdown'
import {UploadOutlined} from '@ant-design/icons'
import {ManagedComponentReact} from '../util/realtime/react/ManagedComponentReact'

//TODO: escalations instead of console.error
//TODO: file upload JSON definition of dashboardu with JSON schema for validation
//TODO: svg upload with escape for script for secure usage

type DashboardCellLayout = {
  /** position from left 0-11 */
  x: number
  /** position from top */
  y: number
  /** width - x coord */
  w: number
  /** height - y coord */
  h: number
}

// TODO: time component shows current server time
// TODO: optional fields - defaults filling functions
// TODO: add comments to json schema

// type DashboardCellType = 'svg' | 'plot' | 'geo'

type DashboardCellSvg = {
  type: 'svg'
  layout: DashboardCellLayout
  field: string | string[]
  file: string
}

// TODO: add to schema
type DashboardCellGeoOpts = {
  zoom?: number
  dragable?: boolean
}

type DashboardCellGeo = {
  type: 'geo'
  layout: DashboardCellLayout
  latField: string
  lonField: string
  Live: DashboardCellGeoOpts
  Past: DashboardCellGeoOpts
}

// type DashboardCellPlotType = 'gauge' | 'line'

type DashboardCellPlotGauge = {
  type: 'plot'
  layout: DashboardCellLayout
  plotType: 'gauge'
  field: string
  label: string
  range: {
    min: number
    max: number
  }
  unit: string
  decimalPlaces: number
}

type DashboardCellPlotLine = {
  layout: DashboardCellLayout
  type: 'plot'
  plotType: 'line'
  field: string | string[]
  label: string
}

type DashboardCellPlot = DashboardCellPlotGauge | DashboardCellPlotLine

type DashboardCell = DashboardCellSvg | DashboardCellPlot | DashboardCellGeo

// TODO: height/width and other props of react grid
type DashboardLayoutDefiniton = {cells: DashboardCell[]}

/*
 ********************************************
 * This page is adaptation of DashboardPage *
 ********************************************
 */

interface DeviceConfig {
  influx_url: string
  influx_org: string
  influx_token: string
  influx_bucket: string
  id: string
}

const fetchDeviceConfig = async (deviceId: string): Promise<DeviceConfig> => {
  const response = await fetch(
    `/api/env/${deviceId}?register=${deviceId === VIRTUAL_DEVICE}`
  )
  if (response.status >= 300) {
    const text = await response.text()
    throw new Error(`${response.status} ${text}`)
  }
  const deviceConfig: DeviceConfig = await response.json()
  if (!deviceConfig.influx_token) {
    throw new Error(`Device '${deviceId}' is not authorized!`)
  }
  return deviceConfig
}

const fetchDeviceKeys = async (
  config: DeviceConfig,
  timeStart = '-30d'
): Promise<string[]> => {
  const {
    // influx_url: url, // use '/influx' proxy to avoid problem with InfluxDB v2 Beta (Docker)
    influx_token: token,
    influx_org: org,
    influx_bucket: bucket,
    id,
  } = config
  const queryApi = new InfluxDB({url: '/influx', token}).getQueryApi(org)
  const result = await queryTable(
    queryApi,
    flux`
    import "influxdata/influxdb/schema"
    schema.fieldKeys(
      bucket: ${bucket},
      predicate: (r) => r["_measurement"] == "environment" and r["clientId"] == ${id},
      start: ${fluxDuration(timeStart)}
    )
    `
  )
  return result?.getColumn('_value', 'string') ?? []
}

const fetchDeviceMeasurements = async (
  config: DeviceConfig,
  timeStart = '-30d',
  fields: string[]
): Promise<GiraffeTable> => {
  const {
    // influx_url: url, // use '/influx' proxy to avoid problem with InfluxDB v2 Beta (Docker)
    influx_token: token,
    influx_org: org,
    influx_bucket: bucket,
    id,
  } = config
  const queryApi = new InfluxDB({url: '/influx', token}).getQueryApi(org)
  const fieldsExpression = fields
    .map((field) => `r["_field"] == "${field}"`)
    .join(' or ')
  const result = await queryTable(
    queryApi,
    flux`
  from(bucket: ${bucket})
    |> range(start: ${fluxDuration(timeStart)})
    |> filter(fn: (r) => r._measurement == "environment")
    |> filter(fn: (r) => r.clientId == ${id})
    |> filter(fn: (r) => ${fluxExpression(fieldsExpression)})`
  )
  return result
}

// fetchDeviceDataFieldLast replaced by taking data from fetchDeviceMeasurements

// we have replaced giraffe with non-react library to handle faster rerendering

/** gauges style based on mesurement definitions */
const gaugesPlotOptionsFor = ({
  decimalPlaces,
  range: {max, min},
  unit,
  layout: {h},
}: DashboardCellPlotGauge): Omit<GaugeOptions, 'percent'> & MinAndMax => ({
  min,
  max,
  range: {
    ticks: [0, 1],
    color: `l(0) 0:${colorPrimary} 1:${colorLink}`,
    width: 15,
  },
  indicator: {
    pointer: {
      style: {stroke: 'gray'},
    },
    pin: {
      style: {stroke: 'gray'},
    },
  },
  axis: {
    position: 'bottom',
    label: {
      formatter: (v: string) => (+v * (max - min) + min).toFixed(0),
      offset: -30,
      style: {
        fontSize: 12,
        fontWeight: 900,
        fontFamily: 'Rubik',
        fill: '#55575E',
        shadowColor: 'white',
      },
    },
    tickLine: {
      // length: 10,
      style: {
        lineWidth: 3,
      },
    },
    subTickLine: {
      count: 9,
      // length: 10,
      style: {
        lineWidth: 1,
      },
    },
  },
  statistic: {
    content: {
      formatter: (x: Datum | undefined) =>
        x
          ? `${(+x.percent * (max - min) + min).toFixed(
              decimalPlaces ?? 0
            )}${unit}`
          : '',
      style: {},
      offsetY: 30,
    },
  },
  height: 80 * h - 28,
  padding: [0, 0, 10, 0],
  renderer: 'svg',
})

/** line plots style based on mesurement definitions */
const linePlotOptionsFor = ({
  layout: {h},
}: DashboardCellPlotLine): Omit<LineOptions, 'data'> => ({
  height: 80 * h - 28,
  legend: false,
  lineStyle: {
    color: colorPrimary,
    lineWidth: 4,
  },
})

const plotOptionsFor = (
  opts: DashboardCellPlot & {layout: DashboardCellLayout}
) => {
  if (opts.plotType === 'gauge') return gaugesPlotOptionsFor(opts)
  if (opts.plotType === 'line') return linePlotOptionsFor(opts)
  throw `Invalid plot cell type! ${JSON.stringify((opts as any)?.plotType)}`
}

// #region Realtime

/** Data returned from websocket in line-protocol-like shape */
type RealtimePoint = {
  measurement: string
  tagPairs: string[]
  fields: Record<string, number | boolean | string>
  timestamp: string
}
type RealtimeSubscription = {
  /** influxdb measurement value */
  measurement: string
  /** tag format 'tagName=tagValue'. Point is sent to client when matches all tags. */
  tags: string[]
}

const host =
  process.env.NODE_ENV === `development`
    ? window.location.hostname + ':5000'
    : window.location.host
const wsAddress = `ws://${host}/mqtt`

/** length of unix time with milliseconds precision */
const MILLIS_TIME_LENGTH = 13
/** Transform timestamps to millis for point. (Points can have different precission) */
const pointTimeToMillis = (p: RealtimePoint): RealtimePoint => ({
  ...p,
  timestamp: p.timestamp
    .substr(0, MILLIS_TIME_LENGTH)
    .padEnd(MILLIS_TIME_LENGTH, '0'),
})

/**
 * subscribes for data to servers broker.js via websocket
 * when any subscription present
 */
const useRealtimeData = (
  subscriptions: RealtimeSubscription[],
  onReceivePoints: (pts: RealtimePoint[]) => void
) => {
  const wsInit = useCallback<(ws: WebSocket) => void>(
    (ws) => {
      ws.onopen = () => ws.send('subscribe:' + JSON.stringify(subscriptions))
      ws.onmessage = (response) =>
        onReceivePoints(
          (JSON.parse(response.data) as RealtimePoint[]).map(pointTimeToMillis)
        )
    },
    [subscriptions, onReceivePoints]
  )
  useWebSocket(wsInit, wsAddress, !!subscriptions.length)
}

// transformations for both InfluxDB and Realtime sources so we can use them same way independently of the source

/** transformation for realtime data returned by websocket */
const realtimePointToDiagrameEntryPoint = (points: RealtimePoint[]) => {
  const newData: DiagramEntryPoint[] = []

  for (const p of points) {
    const fields = p.fields
    const time = Math.floor(+p.timestamp)

    for (const key in fields) {
      const value = fields[key] as number
      newData.push({key, time, value})
    }
  }

  return newData
}

/** transformation for field based giraffe table */
const giraffeTableToDiagramEntryPoints = (
  table: GiraffeTable | undefined
): DiagramEntryPoint[] => {
  if (!table) return []
  const length = table.length
  const timeCol =
    table.getColumn('_time', 'number') ||
    table.getColumn('_start', 'number') ||
    table.getColumn('_stop', 'number')
  const fieldCol = table.getColumn('_field', 'string')
  const valueCol = table.getColumn('_value', 'number')
  if (!timeCol || !fieldCol || !valueCol) return []

  const data: DiagramEntryPoint[] = Array(length)

  for (let i = length; i--; ) {
    data[i] = {key: fieldCol[i], time: timeCol[i], value: valueCol[i]}
  }

  let newLength = data.length
  for (let i = data.length; i--; ) {
    if (data[i].value == null || data[i].time == null) {
      newLength--
      data[i] = data[newLength]
    }
  }
  data.length = newLength

  data.sort((a, b) => a.time - b.time)

  return data
}

// #endregion Realtime

/**
 * definitions for time select. (Live options)
 * realtime options contains retention to be used in plots
 */
const timeOptionsRealtime: {
  label: string
  value: string
  realtimeRetention: number
}[] = [
  {label: 'Live 10s', value: '-10s', realtimeRetention: 10_000},
  {label: 'Live 30s', value: '-30s', realtimeRetention: 30_000},
  {label: 'Live 1m', value: '-1m', realtimeRetention: 60_000},
]

/**
 * definitions for time select. (Past options)
 */
const timeOptions: {label: string; value: string}[] = [
  {label: 'Past 5m', value: '-5m'},
  {label: 'Past 15m', value: '-15m'},
  {label: 'Past 1h', value: '-1h'},
  {label: 'Past 6h', value: '-6h'},
  {label: 'Past 1d', value: '-1d'},
  {label: 'Past 3d', value: '-3d'},
  {label: 'Past 7d', value: '-7d'},
  {label: 'Past 30d', value: '-30d'},
]

const getIsRealtime = (timeStart: string) =>
  timeOptionsRealtime.some((x) => x.value === timeStart)

interface PropsRoute {
  deviceId?: string
}

interface Props {
  helpCollapsed: boolean
  mqttEnabled: boolean | undefined
}

/** Selects source based on timeStart, normalize and feed data into DataManager */
const useSource = (
  deviceId: string,
  timeStart: string,
  fields: string[],
  dataStamp: number
) => {
  const [state, setState] = useState({
    loading: false,
    manager: new DataManager(),
    avalibleFields: [] as string[],
  })

  const isRealtime = getIsRealtime(timeStart)

  // #region realtime

  const [subscriptions, setSubscriptions] = useState<RealtimeSubscription[]>([])
  // updaters are functions that updates plots outside of react state

  /** plot is showed with fixed time range if set */
  const retentionTimeMs = isRealtime
    ? timeOptionsRealtime[
        timeOptionsRealtime.findIndex((x) => x.value === timeStart)
      ].realtimeRetention
    : Infinity

  useEffect(() => {
    state.manager.retentionTimeMs = retentionTimeMs
  }, [retentionTimeMs, state.manager])

  useEffect(() => {
    setSubscriptions(
      isRealtime
        ? [{measurement: 'environment', tags: [`clientId=${deviceId}`]}]
        : []
    )
  }, [deviceId, isRealtime])

  const updateData = useCallback(
    (points: DiagramEntryPoint[] | undefined) => {
      if (points?.length) state.manager.updateData(points)
    },
    [state.manager]
  )

  /** Clear data and resets received data fields state */
  const clearData = useRef(() => {
    state.manager.updateData(undefined)
  }).current

  useRealtimeData(
    subscriptions,
    useRef((points: RealtimePoint[]) => {
      updateData(realtimePointToDiagrameEntryPoint(points))
    }).current
  )

  useEffect(() => {
    if (isRealtime) clearData()
  }, [isRealtime, clearData])
  useEffect(clearData, [deviceId, clearData])

  // #endregion realtime

  // fetch device configuration and data
  useEffect(() => {
    const fetchData = async () => {
      clearData()
      setState((s) => (!s.loading ? {...s, loading: true} : s))
      try {
        const config = await fetchDeviceConfig(deviceId)
        const table = await fetchDeviceMeasurements(config, timeStart, fields)
        const dataPoints = giraffeTableToDiagramEntryPoints(table)
        updateData(dataPoints)
        const avalibleFields = await fetchDeviceKeys(config, timeStart)
        setState((s) => ({...s, avalibleFields}))
      } catch (e) {
        console.error(e)
      } finally {
        setState((s) => (s.loading ? {...s, loading: false} : s))
      }
    }

    // fetch data only if not in realtime mode
    if (!isRealtime) fetchData()
    else
      setState((s) =>
        s.avalibleFields.length ? {...s, avalibleFields: []} : s
      )
  }, [
    deviceId,
    timeStart,
    isRealtime,
    dataStamp,
    fields,
    clearData,
    updateData,
  ])

  return state
}

type DashboardLayoutProps = {
  layoutDefinition: DashboardLayoutDefiniton
  svgStrings?: Record<string, string>
}

/**
 * render dashboard cells for layout, data passed by context
 */
const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  layoutDefinition,
  svgStrings = {},
}) => {
  const {cells} = layoutDefinition

  return (
    <ReactGridLayoutFixed
      cols={12}
      rowHeight={80}
      isResizable={false}
      isDraggable={false}
    >
      {cells.map((cell, i) => (
        <div key={JSON.stringify({cell, i})} data-grid={cell.layout}>
          <div
            style={{height: '100%', width: '100%', backgroundColor: 'white'}}
          >
            <div
              style={{
                height: 28,
                paddingLeft: 10,
                paddingTop: 5,
                // borderBottomColor:"gray", borderBottomWidth:"1px", borderBottomStyle:"solid"
              }}
            >
              {'label' in cell ? cell.label : ''}
            </div>
            <div
              style={{
                height: 'calc(100% - 28px)',
                width: '100%',
                padding: '0px 20px 20px 20px',
              }}
            >
              {cell.type === 'plot' ? (
                <ManagedComponentReact
                  component={ManagedG2Plot}
                  keys={asArray(cell.field)}
                  props={{ctor: cell.plotType, options: plotOptionsFor(cell)}}
                />
              ) : undefined}
              {cell.type === 'geo' ? (
                <ManagedComponentReact
                  component={ManagedMap}
                  keys={[cell.latField, cell.lonField]}
                  props={{}}
                />
              ) : undefined}
              {cell.type === 'svg' ? (
                <ManagedComponentReact
                  component={ManagedSvg}
                  keys={asArray(cell.field)}
                  props={{svgString: svgStrings[cell.file]}}
                />
              ) : undefined}
            </div>
          </div>
        </div>
      ))}
    </ReactGridLayoutFixed>
  )
}

/**
 * returns fields for given layout
 */
const getFields = (layout: DashboardLayoutDefiniton | undefined): string[] => {
  if (!layout) return []
  const fields = new Set<string>()

  layout.cells.forEach((cell) => {
    if (cell.type === 'plot') {
      asArray(cell.field).forEach((f) => fields.add(f))
    } else if (cell.type === 'geo') {
      fields.add(cell.latField)
      fields.add(cell.lonField)
    }
  })

  return Array.from(fields).sort()
}

const useFields = (layout: DashboardLayoutDefiniton | undefined): string[] => {
  const fieldsLayout = getFields(layout)
  const [fields, setFields] = useState<string[]>([])

  if (
    fieldsLayout.length !== fields.length ||
    fieldsLayout.some((f, i) => f !== fields[i])
  ) {
    setFields(fieldsLayout)
  }

  return fields
}

const useLoading = () => {
  const [loading, setLoading] = useState(false)
  const callWithLoading = useCallback(
    async <T,>(fnc: () => Promise<T>): Promise<T> => {
      try {
        setLoading(true)
        return await fnc()
      } finally {
        setLoading(false)
      }
    },
    []
  )

  return {loading, callWithLoading}
}

const dashboardSelectCreateNewOption = 'create new'

const DynamicDashboardPage: FunctionComponent<
  RouteComponentProps<PropsRoute> & Props
> = ({match, history, mqttEnabled}) => {
  const deviceId = match.params.deviceId ?? VIRTUAL_DEVICE
  const [message, setMessage] = useState<Message | undefined>()
  const [dataStamp, setDataStamp] = useState(0)
  const [devices, setDevices] = useState<DeviceInfo[] | undefined>(undefined)
  const [timeStart, setTimeStart] = useState(timeOptionsRealtime[0].value)
  const {loading, callWithLoading} = useLoading()

  // Layout selection
  const [layoutKeys, setLayoutKeys] = useState<string[]>([])
  const [layoutKey, setLayoutKey] = useState<string>()
  const [laoutDefinitions, setLayoutDefinitions] = useState<
    Record<string, DashboardLayoutDefiniton>
  >({})
  const layoutDefinition = laoutDefinitions[layoutKey || '']

  const [helpText, setHelpText] = useState('')
  useEffect(() => {
    // load markdown from file
    const fetchMarkdown = async () => {
      try {
        const [txt, dir] = await Promise.all([
          fetch('/help/DynamicDashboardPage.md').then((x) => x.text()),
          fetch('/api/dynamic/dir').then((x) => x.text()),
        ])
        setHelpText(
          (txt ?? '').startsWith('<!')
            ? 'HELP NOT FOUND'
            : txt.replace('{Dynamic Dir}', dir)
        )
      } catch (e) {
        console.error(e)
      }
    }

    callWithLoading(fetchMarkdown)
  }, [callWithLoading])

  useEffect(() => {
    const fetchLaoutKeys = async () => {
      const response = await fetch('/api/dynamic/keys')
      const keys = await response.json()
      setLayoutKeys(keys)
      setLayoutKey(keys[0])
    }

    callWithLoading(fetchLaoutKeys)
  }, [callWithLoading])

  useEffect(() => {
    const fetchLaoutConfig = async () => {
      if (
        !layoutKey ||
        layoutKey === dashboardSelectCreateNewOption ||
        layoutDefinition
      )
        return
      const response = await fetch(`/api/dynamic/dashboard/${layoutKey}`)
      const config = await response.json()
      setLayoutDefinitions((c) => ({...c, [layoutKey]: config}))
    }

    callWithLoading(fetchLaoutConfig)
  }, [layoutKey, layoutDefinition, callWithLoading])

  const isRealtime = getIsRealtime(timeStart)

  const fields = useFields(layoutDefinition)

  const [svgStrings, setSvgStrings] = useState<Record<string, string>>({})

  useEffect(() => {
    const fetchSvgStrings = async () => {
      if (!layoutDefinition) return
      try {
        const isDashboarCellSvg = (c: DashboardCell): c is DashboardCellSvg => {
          return c.type === 'svg'
        }

        const svgKeys = layoutDefinition.cells
          .filter(isDashboarCellSvg)
          .map((x) => x.file)

        const results = await Promise.all(
          svgKeys.map(async (key) => {
            const res = await fetch(`/api/dynamic/svg/${key}`)
            const text = await res.text()
            return [key, text] as const
          })
        )

        setSvgStrings(Object.fromEntries(results))
      } catch (e) {
        console.error(e)
      }
    }

    callWithLoading(fetchSvgStrings)
  }, [layoutDefinition, callWithLoading])

  const {loading: loadingSource, manager, avalibleFields} = useSource(
    deviceId,
    timeStart,
    fields,
    dataStamp
  )

  // Default time selected to Past when mqtt not configured
  useEffect(() => {
    if (mqttEnabled === false) {
      setTimeStart(timeOptions[0].value)
    }
  }, [mqttEnabled])

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const response = await fetch('/api/devices')
        if (response.status >= 300) {
          const text = await response.text()
          throw new Error(`${response.status} ${text}`)
        }
        const data = await response.json()
        setDevices(data)
      } catch (e) {
        setMessage({
          title: 'Cannot fetch data',
          description: String(e),
          type: 'error',
        })
      }
    }

    callWithLoading(fetchDevices)
  }, [callWithLoading])

  const pageControls = (
    <>
      <Tooltip title={'Choose dashboard'} placement="left">
        <Select
          value={layoutKey}
          onChange={setLayoutKey}
          style={{minWidth: 100}}
          loading={loadingSource || mqttEnabled === undefined}
          disabled={loadingSource}
        >
          {layoutKeys.map((key) => (
            <Select.Option key={key} value={key}>
              {key}
            </Select.Option>
          ))}
          <Select.Option
            key={dashboardSelectCreateNewOption}
            value={dashboardSelectCreateNewOption}
            style={{background: '#00d019', color: 'black'}}
          >
            {dashboardSelectCreateNewOption}
          </Select.Option>
        </Select>
      </Tooltip>

      <Tooltip title="Choose device" placement="left">
        <Select
          showSearch
          value={deviceId}
          placeholder={'select device to show'}
          showArrow={true}
          filterOption={true}
          // goes to dynamic page (instead of dashboard)
          onChange={(key) => history.push(`/dynamic/${key}`)}
          style={{minWidth: 200, width: 350, marginRight: 10}}
          loading={!devices}
          disabled={!devices}
        >
          {devices &&
            devices.map(({deviceId}) => (
              <Select.Option key={deviceId} value={deviceId}>
                {deviceId}
              </Select.Option>
            ))}
        </Select>
      </Tooltip>

      <Tooltip
        title={
          (mqttEnabled === false ? 'MQTT not configured on server! ' : '') +
          'Choose time'
        }
        placement="left"
      >
        <Select
          value={timeStart}
          onChange={setTimeStart}
          style={{minWidth: 100}}
          loading={loadingSource || mqttEnabled === undefined}
          disabled={loadingSource}
        >
          {timeOptionsRealtime.map(({label, value}) => (
            <Select.Option
              disabled={mqttEnabled === false}
              key={value}
              value={value}
            >
              {label}
            </Select.Option>
          ))}
          {timeOptions.map(({label, value}) => (
            <Select.Option key={value} value={value}>
              {label}
            </Select.Option>
          ))}
        </Select>
      </Tooltip>

      <Tooltip title="Reload Device Data">
        <Button
          // disable refresh when in realtime mode
          disabled={loadingSource || isRealtime}
          loading={loadingSource}
          onClick={() => setDataStamp(dataStamp + 1)}
          style={{marginLeft: 10}}
          icon={<IconRefresh />}
        />
      </Tooltip>

      <Tooltip title="Go to device settings" placement="topRight">
        <Button
          type="primary"
          icon={<IconSettings />}
          style={{marginLeft: 10}}
          href={`/devices/${deviceId}`}
        ></Button>
      </Tooltip>
    </>
  )

  const influxUnusedFields =
    layoutKey === dashboardSelectCreateNewOption
      ? ''
      : avalibleFields.filter((x) => !fields.some((y) => y === x)).join(', ')

  return (
    <PageContent
      title={'Dynamic Dashboard'}
      titleExtra={pageControls}
      message={message}
      spin={loading || loadingSource}
      forceShowScroll={true}
    >
      <div style={{position: 'absolute', zIndex: 2, right: 0}}>
        {influxUnusedFields?.length
          ? `influx unused fields: ${influxUnusedFields}`
          : ''}
      </div>
      <DataManagerContextProvider value={manager}>
        {layoutDefinition ? (
          <DashboardLayout {...{layoutDefinition, svgStrings}} />
        ) : undefined}
      </DataManagerContextProvider>

      {layoutKey === dashboardSelectCreateNewOption ? (
        <Card
          title="How to create new dynamic dashboard"
          extra={
            <Upload
              accept=".json,.svg"
              multiple={true}
              beforeUpload={(file) => {
                const reader = new FileReader()
                reader.onload = (e) => {
                  const text = (e?.target?.result as string | undefined) ?? ''
                  fetch(`/api/dynamic/upload/${file.name}`, {
                    body: text,
                    method: 'POST',
                  })
                }
                reader.readAsText(file)

                return false
              }}
            >
              <Button icon={<UploadOutlined />}>Upload</Button>
            </Upload>
          }
        >
          <Markdown source={helpText} />
        </Card>
      ) : undefined}
    </PageContent>
  )
}

export default DynamicDashboardPage
