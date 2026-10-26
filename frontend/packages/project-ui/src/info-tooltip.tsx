import { ReactElement, ReactNode } from 'react'
import { Tooltip, type TooltipProps } from '@mui/material'

interface InfoTooltipProps {
  title: ReactNode
  children: ReactElement
  describeChild?: boolean
  placement?: TooltipProps['placement']
}

export const InfoTooltip = ({ title, children, describeChild = false, placement }: InfoTooltipProps) => {
  return (
    <Tooltip title={title} arrow describeChild={describeChild} placement={placement}>
      {children}
    </Tooltip>
  )
}
